// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  annotationOverrideId,
  applyAnnotationOverrides,
  collectDraftAnnotationTargets,
  collectTimelineAnnotations,
  findQuoteRange,
  getAnnotationOverridesSnapshot,
  parseSelectionCarryovers,
  resetAnnotationOverridesForTests,
  subscribeAnnotationOverrides,
  writeAnnotationOverride,
  type TimelineAnnotation,
} from './timelineAnnotations';
import { selectionCarryoverPresentation, sourceTextVersion } from './selectionQuote';

type CarryoverArguments = Parameters<typeof selectionCarryoverPresentation>;

const block = (id: string, kind: string, text: string, presentation?: ReturnType<typeof selectionCarryoverPresentation>['presentation']) =>
  presentation === undefined ? { id, kind, text } : { id, kind, text, presentation };

const presented = (
  id: string,
  kind: string,
  annotations: CarryoverArguments[0],
  quote: CarryoverArguments[1] = null,
  body = '',
  quoteSource?: CarryoverArguments[2],
) => {
  const carry = selectionCarryoverPresentation(annotations, quote, quoteSource);
  return block(id, kind, `${carry.prefix}${body}`, carry.presentation);
};

describe('parseSelectionCarryovers', () => {
  it('round-trips producer metadata for multiline comments, a second annotation, and a source', () => {
    const source = { blockId: 'assistant-2', version: 'v2', start: 4, end: 10, text: 'second' };
    const annotations = [
      { quote: 'first fragment\nacross lines', comment: 'comment one\nwith detail' },
      { quote: 'second', comment: 'comment two', source },
    ];
    const carry = selectionCarryoverPresentation(annotations, 'plain quote', source);
    const parsed = parseSelectionCarryovers(`${carry.prefix}typed body`, carry.presentation);
    expect(parsed.annotations).toEqual(annotations);
    expect(parsed.quote).toBe('plain quote');
    expect(parsed.quoteSource).toEqual(source);
    expect(parsed.body).toBe('typed body');
  });

  it('parses a producer-marked quote-only message', () => {
    const carry = selectionCarryoverPresentation([], 'just a quote');
    const parsed = parseSelectionCarryovers(carry.prefix, carry.presentation);
    expect(parsed.annotations).toEqual([]);
    expect(parsed.quote).toBe('just a quote');
    expect(parsed.body).toBe('');
  });

  it('returns an empty prefix for ordinary text', () => {
    const parsed = parseSelectionCarryovers('hello world');
    expect(parsed.annotations).toEqual([]);
    expect(parsed.quote).toBeNull();
    expect(parsed.body).toBe('hello world');
  });

  it('projects the body after an explicit generated selection prefix', () => {
    const carry = selectionCarryoverPresentation([{ quote: 'quoted', comment: 'noted' }], null);
    const parsed = parseSelectionCarryovers(`${carry.prefix}body starts\n> not a quote`, carry.presentation);
    expect(parsed.annotations).toEqual([{ quote: 'quoted', comment: 'noted', source: undefined }]);
    expect(parsed.quote).toBeNull();
    expect(parsed.body).toBe('body starts\n> not a quote');
  });

  it('keeps user-authored XML, tags, and blockquotes literal without producer metadata', () => {
    const text = '> line one\n>\n> line three\n\nComment: c\n\n<thread_refs>\nuser note\n</thread_refs>';
    const parsed = parseSelectionCarryovers(text);
    expect(parsed.annotations).toEqual([]);
    expect(parsed.quote).toBeNull();
    expect(parsed.body).toBe(text);
  });
});

describe('findQuoteRange', () => {
  it('finds a plain substring', () => {
    expect(findQuoteRange('the quick brown fox', 'quick brown')).toEqual({ start: 4, end: 15 });
  });

  it('matches rendered text against markdown source', () => {
    const raw = 'the **quick** brown [fox](https://example.com) jumps';
    const range = findQuoteRange(raw, 'quick brown');
    expect(range).toEqual({ start: 6, end: 19 });
    expect(raw.slice(range?.start, range?.end)).toBe('quick** brown');
  });

  it('ignores punctuation and whitespace differences', () => {
    expect(findQuoteRange('a, b — c', 'a b c')).toEqual({ start: 0, end: 8 });
  });

  it('matches CJK text', () => {
    expect(findQuoteRange('把转写块按楼层分批处理', '按楼层分批')).toEqual({ start: 4, end: 9 });
  });

  it('returns null when the quote has no anchor characters', () => {
    expect(findQuoteRange('anything', '… — …')).toBeNull();
  });

  it('returns null when the quote is absent', () => {
    expect(findQuoteRange('hello world', 'missing text')).toBeNull();
  });

  it('anchors across astral letters without splitting a surrogate pair', () => {
    const range = findQuoteRange('a 𠀀 b', '𠀀 b');
    expect(range).toEqual({ start: 2, end: 6 });
    expect('a 𠀀 b'.slice(range?.start, range?.end)).toBe('𠀀 b');
  });
});

describe('collectTimelineAnnotations', () => {
  const ASSISTANT = 'The queue batches transcript blocks into floors and drains parked prompts in order.';

  it('does not guess a legacy source when different messages contain identical quotes', () => {
    const quote = 'batches transcript blocks into floors';
    const targets = collectTimelineAnnotations([
      block('a1', 'assistant', `prefix ${quote} suffix`),
      block('a2', 'assistant', `nearer ${quote} here`),
      presented('u1', 'user', [{ quote, comment: 'floors matter' }]),
    ]);
    expect(targets.size).toBe(0);
  });

  it('derives quote-kind segments with a null comment', () => {
    const targets = collectTimelineAnnotations([
      block('a1', 'assistant', ASSISTANT),
      presented('u1', 'user', [], 'drains parked prompts in order'),
    ]);
    expect(targets.get('a1')?.[0]).toMatchObject({
      quote: 'drains parked prompts in order',
      comment: null,
    });
  });

  it('never anchors to the carrying block itself', () => {
    const quote = 'batches transcript blocks into floors';
    const targets = collectTimelineAnnotations([
      presented('u1', 'user', [{ quote, comment: 'self' }]),
    ]);
    expect(targets.size).toBe(0);
  });

  it('skips non-message anchor kinds', () => {
    const quote = 'tool output fragment';
    const targets = collectTimelineAnnotations([
      block('t1', 'tool', quote),
      presented('u1', 'user', [{ quote, comment: 'c' }]),
    ]);
    expect(targets.size).toBe(0);
  });

  it('collects multiple segments into one block and drops unmatchable ones', () => {
    const annotations = [
      { quote: 'batches transcript blocks into floors', comment: 'first' },
      { quote: 'a quote that appears nowhere', comment: 'second' },
    ];
    const targets = collectTimelineAnnotations([
      block('a1', 'assistant', ASSISTANT),
      presented('u1', 'user', annotations),
    ]);
    const list = targets.get('a1');
    expect(list).toHaveLength(1);
    expect(list?.[0]?.comment).toBe('first');
  });

  it('keeps identical annotations from separate messages independently addressable', () => {
    const quote = 'batches transcript blocks into floors';
    const carrier = (carrierId: string, sourceBlockId: string) => presented(carrierId, 'user', [{ quote, comment: 'same', source: {
      blockId: sourceBlockId, version: sourceTextVersion(ASSISTANT), start: 8, end: 8 + quote.replaceAll(' ', '').length, text: quote.replaceAll(' ', ''),
    } }]);
    const targets = collectTimelineAnnotations([
      block('a1', 'assistant', ASSISTANT),
      carrier('u1', 'a1'),
      block('a2', 'assistant', ASSISTANT),
      carrier('u2', 'a2'),
    ]);
    const first = targets.get('a1')?.[0]?.id;
    const second = targets.get('a2')?.[0]?.id;
    expect(first).toBe(annotationOverrideId(quote, 'same', 'u1', 0));
    expect(second).toBe(annotationOverrideId(quote, 'same', 'u2', 0));
    expect(first).not.toBe(second);
  });
});

describe('collectDraftAnnotationTargets', () => {
  const ASSISTANT = 'The queue batches transcript blocks into floors and drains parked prompts in order.';

  it('keeps a unique legacy draft source, but never guesses among duplicate messages', () => {
    const draft = { id: 'draft-1', quote: 'batches transcript blocks into floors', comment: 'floors matter' };
    const blocks = [block('a1', 'assistant', ASSISTANT)];
    expect(collectDraftAnnotationTargets(blocks, []).size).toBe(0);
    expect(collectDraftAnnotationTargets(blocks, [draft]).get('a1')).toEqual([draft]);
    expect(collectDraftAnnotationTargets([...blocks, block('a2', 'assistant', ASSISTANT)], [draft]).size).toBe(0);
  });

  it('marks user messages too and drops drafts whose quote matches nothing', () => {
    const targets = collectDraftAnnotationTargets(
      [block('u1', 'user', 'send it as one message')],
      [
        { id: 'draft-hit', quote: 'one message', comment: 'yes' },
        { id: 'draft-miss', quote: 'appears nowhere', comment: 'no' },
      ],
    );
    expect(targets.get('u1')).toEqual([{ id: 'draft-hit', quote: 'one message', comment: 'yes' }]);
    expect(targets.size).toBe(1);
  });
});

describe('annotation overrides', () => {
  beforeEach(() => {
    localStorage.clear();
    resetAnnotationOverridesForTests();
  });
  afterEach(() => {
    resetAnnotationOverridesForTests();
    localStorage.clear();
  });

  const base: readonly TimelineAnnotation[] = [
    { id: annotationOverrideId('q', 'original'), quote: 'q', comment: 'original' },
  ];
  const targets = new Map([['a1', base]]);

  it('returns the input unchanged when no overrides exist', () => {
    expect(applyAnnotationOverrides(targets, {})).toBe(targets);
  });

  it('applies comment edits and deletions', () => {
    const id = annotationOverrideId('q', 'original');
    const edited = applyAnnotationOverrides(targets, { [id]: { comment: 'edited' } });
    expect(edited.get('a1')?.[0]?.comment).toBe('edited');
    const deleted = applyAnnotationOverrides(targets, { [id]: { deleted: true } });
    expect(deleted.size).toBe(0);
  });

  it('persists writes, notifies subscribers, and clears with null', () => {
    const id = annotationOverrideId('q', 'original');
    let notifications = 0;
    const unsubscribe = subscribeAnnotationOverrides(() => {
      notifications += 1;
    });
    writeAnnotationOverride(id, { comment: 'edited' });
    expect(notifications).toBe(1);
    expect(getAnnotationOverridesSnapshot()[id]).toEqual({ comment: 'edited' });
    const firstSnapshot = getAnnotationOverridesSnapshot();
    expect(getAnnotationOverridesSnapshot()).toBe(firstSnapshot);
    writeAnnotationOverride(id, null);
    expect(notifications).toBe(2);
    expect(getAnnotationOverridesSnapshot()[id]).toBeUndefined();
    unsubscribe();
  });

  it('drops empty patches instead of storing them', () => {
    const id = annotationOverrideId('q', 'original');
    writeAnnotationOverride(id, {});
    expect(getAnnotationOverridesSnapshot()[id]).toBeUndefined();
  });
});

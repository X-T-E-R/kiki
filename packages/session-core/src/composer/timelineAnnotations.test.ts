// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  annotationOverrideId,
  applyAnnotationOverrides,
  collectTimelineAnnotations,
  findQuoteRange,
  getAnnotationOverridesSnapshot,
  parseSelectionCarryovers,
  resetAnnotationOverridesForTests,
  subscribeAnnotationOverrides,
  writeAnnotationOverride,
  type TimelineAnnotation,
} from './timelineAnnotations';
import { buildAnnotationsPrefix, buildQuotePrefix } from './selectionQuote';

const block = (id: string, kind: string, text: string) => ({ id, kind, text });

describe('parseSelectionCarryovers', () => {
  it('round-trips the constructed wire layout', () => {
    const annotations = [
      { quote: 'first fragment', comment: 'comment one' },
      { quote: 'second fragment\nacross lines', comment: 'comment two' },
    ];
    const text = `${buildAnnotationsPrefix(annotations)}${buildQuotePrefix('plain quote')}typed body`;
    const parsed = parseSelectionCarryovers(text);
    expect(parsed.annotations).toEqual(annotations);
    expect(parsed.quote).toBe('plain quote');
    expect(parsed.body).toBe('typed body');
  });

  it('parses a quote-only message', () => {
    const parsed = parseSelectionCarryovers(buildQuotePrefix('just a quote'));
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

  it('stops the prefix at the first non-quote line', () => {
    const parsed = parseSelectionCarryovers('> quoted\n\nComment: noted\n\nbody starts\n> not a quote');
    expect(parsed.annotations).toEqual([{ quote: 'quoted', comment: 'noted' }]);
    expect(parsed.quote).toBeNull();
    expect(parsed.body).toBe('body starts\n> not a quote');
  });

  it('keeps blank quote lines inside a multi-line quote', () => {
    const parsed = parseSelectionCarryovers('> line one\n>\n> line three\n\nComment: c\n\n');
    expect(parsed.annotations).toEqual([{ quote: 'line one\n\nline three', comment: 'c' }]);
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

  it('anchors an annotation to the nearest preceding block containing the quote', () => {
    const quote = 'batches transcript blocks into floors';
    const text = `> ${quote}\n\nComment: floors matter\n\n`;
    const targets = collectTimelineAnnotations([
      block('a1', 'assistant', `prefix ${quote} suffix`),
      block('a2', 'assistant', `nearer ${quote} here`),
      block('u1', 'user', text),
    ]);
    expect(targets.has('a1')).toBe(false);
    const list = targets.get('a2');
    expect(list).toHaveLength(1);
    expect(list?.[0]).toMatchObject({ quote, comment: 'floors matter' });
  });

  it('derives quote-kind segments with a null comment', () => {
    const targets = collectTimelineAnnotations([
      block('a1', 'assistant', ASSISTANT),
      block('u1', 'user', '> drains parked prompts in order\n\n'),
    ]);
    expect(targets.get('a1')?.[0]).toMatchObject({
      quote: 'drains parked prompts in order',
      comment: null,
    });
  });

  it('never anchors to the carrying block itself', () => {
    const quote = 'batches transcript blocks into floors';
    const targets = collectTimelineAnnotations([
      block('u1', 'user', `> ${quote}\n\nComment: self\n\n`),
    ]);
    expect(targets.size).toBe(0);
  });

  it('skips non-message anchor kinds', () => {
    const quote = 'tool output fragment';
    const targets = collectTimelineAnnotations([
      block('t1', 'tool', quote),
      block('u1', 'user', `> ${quote}\n\nComment: c\n\n`),
    ]);
    expect(targets.size).toBe(0);
  });

  it('collects multiple segments into one block and drops unmatchable ones', () => {
    const text =
      '> batches transcript blocks into floors\n\nComment: first\n\n' +
      '> a quote that appears nowhere\n\nComment: second\n\n';
    const targets = collectTimelineAnnotations([
      block('a1', 'assistant', ASSISTANT),
      block('u1', 'user', text),
    ]);
    const list = targets.get('a1');
    expect(list).toHaveLength(1);
    expect(list?.[0]?.comment).toBe('first');
  });

  it('keeps identical annotations from separate messages independently addressable', () => {
    const quote = 'batches transcript blocks into floors';
    const text = `> ${quote}\n\nComment: same\n\n`;
    const targets = collectTimelineAnnotations([
      block('a1', 'assistant', ASSISTANT),
      block('u1', 'user', text),
      block('a2', 'assistant', ASSISTANT),
      block('u2', 'user', text),
    ]);
    const first = targets.get('a1')?.[0]?.id;
    const second = targets.get('a2')?.[0]?.id;
    expect(first).toBe(annotationOverrideId(quote, 'same', 'u1', 0));
    expect(second).toBe(annotationOverrideId(quote, 'same', 'u2', 0));
    expect(first).not.toBe(second);
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

// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  addAnnotation,
  buildAnnotationBlock,
  buildAnnotationsPrefix,
  buildQuotePrefix,
  removeAnnotation,
  selectionAnchorRect,
  selectionTextWithin,
} from './selectionQuote';

describe('buildQuotePrefix', () => {
  it('prefixes a single line and ends with a blank separator', () => {
    expect(buildQuotePrefix('hello world')).toBe('> hello world\n\n');
  });

  it('prefixes every line of a multiline selection', () => {
    expect(buildQuotePrefix('first\nsecond\nthird')).toBe('> first\n> second\n> third\n\n');
  });

  it('normalizes CRLF and collapses blank lines to a bare >', () => {
    expect(buildQuotePrefix('one\r\n\r\ntwo')).toBe('> one\n>\n> two\n\n');
  });

  it('trims trailing whitespace per line', () => {
    expect(buildQuotePrefix('padded   \nnext\t')).toBe('> padded\n> next\n\n');
  });
});

describe('buildAnnotationBlock', () => {
  it('renders the source as a blockquote followed by the comment line', () => {
    expect(buildAnnotationBlock({ quote: 'source text', comment: 'worth revisiting' })).toBe(
      '> source text\n\nComment: worth revisiting\n\n',
    );
  });

  it('quotes every line of a multiline source and trims the comment', () => {
    expect(buildAnnotationBlock({ quote: 'one\ntwo', comment: '  noted  ' })).toBe(
      '> one\n> two\n\nComment: noted\n\n',
    );
  });
});

describe('buildAnnotationsPrefix', () => {
  it('is empty without annotations', () => {
    expect(buildAnnotationsPrefix([])).toBe('');
  });

  it('concatenates segments in order, each fully self-contained', () => {
    const prefix = buildAnnotationsPrefix([
      { quote: 'first quote', comment: 'first note' },
      { quote: 'second quote', comment: 'second note' },
    ]);
    expect(prefix).toBe(
      '> first quote\n\nComment: first note\n\n> second quote\n\nComment: second note\n\n',
    );
  });
});

describe('addAnnotation / removeAnnotation', () => {
  it('accumulates annotations with unique ids and never overwrites', () => {
    const one = addAnnotation([], 'quote-a', 'note-a');
    const two = addAnnotation(one, 'quote-b', 'note-b');
    expect(one).toHaveLength(1); // the input list is untouched
    expect(two).toHaveLength(2);
    expect(two[0]).toMatchObject({ quote: 'quote-a', comment: 'note-a' });
    expect(two[1]).toMatchObject({ quote: 'quote-b', comment: 'note-b' });
    expect(two[0]!.id).not.toBe(two[1]!.id);
  });

  it('removes only the targeted annotation, preserving order', () => {
    const list = addAnnotation(addAnnotation(addAnnotation([], 'q1', 'c1'), 'q2', 'c2'), 'q3', 'c3');
    const next = removeAnnotation(list, list[1]!.id);
    expect(next.map((annotation) => annotation.comment)).toEqual(['c1', 'c3']);
    expect(list).toHaveLength(3); // the input list is untouched
  });
});

function selectText(node: Node): Selection {
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe('selectionTextWithin', () => {
  it('returns the trimmed selection text when fully inside the container', () => {
    const container = document.createElement('div');
    container.innerHTML = '<p>hello <b>brave</b> world</p>';
    document.body.appendChild(container);
    const selection = selectText(container.querySelector('p')!);
    expect(selectionTextWithin(container, selection)).toBe('hello brave world');
    container.remove();
  });

  it('returns null for a collapsed or empty selection', () => {
    const container = document.createElement('div');
    container.textContent = 'text';
    document.body.appendChild(container);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    expect(selectionTextWithin(container, selection)).toBeNull();
    selection.collapse(container.firstChild!, 1);
    expect(selectionTextWithin(container, selection)).toBeNull();
    container.remove();
  });

  it('returns null when the selection lives outside the container', () => {
    const container = document.createElement('div');
    container.textContent = 'inside';
    const outside = document.createElement('p');
    outside.textContent = 'outside text';
    document.body.append(container, outside);
    const selection = selectText(outside);
    expect(selectionTextWithin(container, selection)).toBeNull();
    container.remove();
    outside.remove();
  });

  it('returns null when the selection crosses the container boundary', () => {
    const container = document.createElement('div');
    container.textContent = 'in';
    const outside = document.createElement('p');
    outside.textContent = 'out';
    document.body.append(container, outside);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.setBaseAndExtent(container.firstChild!, 0, outside.firstChild!, 3);
    expect(selectionTextWithin(container, selection)).toBeNull();
    container.remove();
    outside.remove();
  });
});

describe('selectionAnchorRect', () => {
  it('returns null for a range-less selection', () => {
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    expect(selectionAnchorRect(selection)).toBeNull();
  });

  it('returns null for a zero-size rect (jsdom geometry)', () => {
    const node = document.createElement('p');
    node.textContent = 'some text';
    document.body.appendChild(node);
    const selection = selectText(node);
    // jsdom reports all-zero rects; the guard treats them as "no anchor".
    expect(selectionAnchorRect(selection)).toBeNull();
    node.remove();
  });
});

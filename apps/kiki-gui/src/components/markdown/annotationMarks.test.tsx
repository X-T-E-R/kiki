// @vitest-environment jsdom

/**
 * Annotation speech-bubble discovery aid — the small glyph rendered right
 * after each annotated passage. The bubble carries the same
 * `data-annotation-ref` as the mark, so the transcript's delegated click
 * opens the same AnnotationPopover from the bubble (the popover-open path
 * itself is covered by Transcript.test.tsx's timeline-annotation suite); the
 * bubble stays `aria-hidden` and non-focusable — the mark remains the single
 * keyboard / screen-reader entry point.
 */

import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { selectionSourceAnchor, type TimelineAnnotation } from '@kiki/session-core/composer';
import { Markdown } from '../Markdown';
import {
  ANNOTATION_BUBBLE_GLYPH,
  projectTextWithAnnotationMarks,
  resolveMarkRanges,
} from './annotationMarks';

vi.mock('./streamdown-plugins', async (importOriginal) => {
  const original = await importOriginal<typeof import('./streamdown-plugins')>();
  return { ...original, useStreamdownPlugins: () => ({}) };
});

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
const originalDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();

function makeRoot(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  return { root, container };
}

/**
 * Unmount every mounted root from earlier tests first: a mounted Markdown from
 * a previous test keeps streamdown's deferred transition commits alive, and
 * those commits must not land inside a later test's act scope.
 */
async function renderSettled(node: Parameters<Root['render']>[0]): Promise<HTMLDivElement> {
  while (roots.length > 0) {
    const root = roots.pop()!;
    await act(async () => {
      flushSync(() => { root.unmount(); });
    });
    containers.pop()!.remove();
  }
  const { root, container } = makeRoot();
  await act(async () => {
    flushSync(() => {
      root.render(
        <MemoryRouter>
          <I18nProvider>{node}</I18nProvider>
        </MemoryRouter>,
      );
    });
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await act(async () => {
    while (roots.length > 0) roots.pop()!.unmount();
  });
  while (containers.length > 0) containers.pop()!.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('resolveMarkRanges', () => {
  it('locates one range per target and drops overlapping matches', () => {
    const ranges = resolveMarkRanges('alpha beta gamma', [
      { id: 'ta-1', quote: 'beta', comment: 'note' },
    ]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ start: 6, end: 10, annotationId: 'ta-1' });
  });
});

describe('plain-text annotation bubble', () => {
  it('follows each mark with a speech-bubble glyph sharing the annotation ref', async () => {
    const mount = await renderSettled(
      <div>
        {projectTextWithAnnotationMarks('alpha beta gamma', [
          { id: 'ta-plain', quote: 'beta', comment: 'note' },
        ])}
      </div>,
    );
    const marks = mount.querySelectorAll('mark[data-annotation-ref]');
    expect(marks).toHaveLength(1);
    const bubble = mount.querySelector('[data-annotation-ref="ta-plain"]:not(mark)');
    expect(bubble?.textContent).toBe('');
    expect(bubble?.className).toContain(`before:content-['${ANNOTATION_BUBBLE_GLYPH}']`);
    expect(bubble?.getAttribute('aria-hidden')).toBe('true');
    // The bubble is decorative: no focusable button role beside the mark.
    expect(bubble?.getAttribute('tabindex')).toBeNull();
    expect(mount.textContent).toContain('alpha beta');
  });
});

describe('markdown annotation bubble', () => {
  it('renders the bubble after the mark in plain-prose fast path', async () => {
    const container = await renderSettled(
      <Markdown
        text="plain prose with the annotated passage"
        annotationTargets={[{ id: 'ta-prose', quote: 'annotated passage', comment: null }]}
      />,
    );
    const bubble = container.querySelector<HTMLElement>('span[data-annotation-ref="ta-prose"]');
    expect(bubble?.textContent).toBe('');
    expect(bubble?.className).toContain(`before:content-['${ANNOTATION_BUBBLE_GLYPH}']`);
    expect(bubble?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders the bubble after the last split node when inline formatting splits one annotation', async () => {
    const container = await renderSettled(
      <Markdown
        text="The renderer **batches transcript blocks** into floors."
        annotationTargets={[{ id: 'ta-split', quote: 'batches transcript blocks into floors', comment: null }]}
      />,
    );
    const marks = container.querySelectorAll('mark[data-annotation-ref="ta-split"]');
    expect(marks.length).toBeGreaterThanOrEqual(2);
    const bubbles = container.querySelectorAll('span[data-annotation-ref="ta-split"]');
    // Exactly one bubble — after the LAST split node (the visual end of the
    // annotated passage), while the interactive mark stays the first.
    expect(bubbles).toHaveLength(1);
    const lastMark = marks[marks.length - 1]!;
    expect(
      lastMark.nextElementSibling?.getAttribute('data-annotation-ref'),
    ).toBe('ta-split');
    expect(lastMark.nextElementSibling?.nextSibling?.textContent).toContain('.');
    // The first mark keeps the keyboard entry point.
    expect(marks[0]!.getAttribute('tabindex')).toBe('0');
  });
});


describe('precise rendered source marks', () => {
  async function captured(text: string, select: (container: HTMLElement, range: Range) => void): Promise<TimelineAnnotation> {
    const container = await renderSettled(<Markdown text={text} mode="static" sourceBlockId="source" />);
    const range = document.createRange();
    select(container, range);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const source = selectionSourceAnchor(selection);
    expect(source).not.toBeNull();
    return { id: 'captured', quote: selection.toString(), comment: 'note', source };
  }

  it('marks only the selected repeated occurrence, and rejects stale rendered offsets', async () => {
    const text = 'same **same** tail';
    const target = await captured(text, (container, range) => range.selectNodeContents(container.querySelector('[data-streamdown="strong"]')!));
    const container = await renderSettled(<Markdown text={text} annotationTargets={[target]} />);
    expect(container.querySelectorAll('mark'), JSON.stringify(target) + container.innerHTML).toHaveLength(1);
    expect(container.querySelector('[data-streamdown="strong"] > mark')?.textContent).toBe('same');
    expect(container.querySelector('p > mark')).toBeNull();
    const stale = await renderSettled(<Markdown text="same **changed** tail" annotationTargets={[target]} />);
    expect(stale.querySelector('mark')).toBeNull();
  });

  it('retains multiple targets and one multi-paragraph range across Markdown formatting', async () => {
    const text = 'First **bold passage**.\n\nSecond *line here*.\n\nLast paragraph.';
    const target = await captured(text, (container, range) => {
      range.setStart(container.querySelector('[data-streamdown="strong"]')!.firstChild!, 0);
      range.setEnd(container.querySelector('em')!.firstChild!, 4);
    });
    const last = await captured(text, (container, range) => range.selectNodeContents(container.querySelectorAll('p')[2]!));
    const container = await renderSettled(<Markdown text={text} annotationTargets={[target, { ...last, id: 'last' }]} />);
    expect([...container.querySelectorAll('p')].slice(0, 2).map((paragraph) => [...paragraph.querySelectorAll('mark[data-annotation-ref="captured"]')].map((mark) => mark.textContent).join(''))).toEqual(['bold passage.', 'Second line']);
    expect(container.querySelector(':scope > .kiki-md > div > mark')).toBeNull();
    expect(container.querySelector('mark[data-annotation-ref="last"]')?.textContent).toBe('Last paragraph.');
    expect(container.querySelectorAll('span[data-annotation-ref="captured"]')).toHaveLength(1);
    expect(container.querySelectorAll('mark[tabindex="0"]')).toHaveLength(2);
  });

  it('marks inline and fenced code without changing code text or losing the copy control', async () => {
    const text = 'Use `value` here.\n\n```ts\nconst value = 1;\nconst other = value;\n```';
    const target = await captured(text, (container, range) => {
      const code = container.querySelector('.kiki-cb-body code')!;
      range.selectNodeContents(code);
    });
    const container = await renderSettled(<Markdown text={text} annotationTargets={[target, { id: 'inline', quote: 'value', comment: null, source: { ...target.source!, start: 3, end: 8, text: 'value' } }]} />);
    expect(container.querySelector('.kiki-cb-body mark')?.textContent).toContain('const value = 1;');
    expect(container.querySelector('.kiki-cb-body code')?.textContent?.trim()).toBe('const value = 1;\nconst other = value;');
    expect(container.querySelector('.kiki-cb-tools button')).not.toBeNull();
    expect(container.querySelector('p code mark[data-annotation-ref="inline"]')?.textContent).toBe('value');
  });
});

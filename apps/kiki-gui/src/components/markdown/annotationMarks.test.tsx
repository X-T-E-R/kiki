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

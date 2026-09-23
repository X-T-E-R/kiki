// @vitest-environment jsdom

/**
 * Late-annotation regression: the real timeline flow renders the assistant
 * message first, the user annotates afterwards. Streamdown's own memo does
 * not compare `rehypePlugins`, so the mark plugin never ran on an
 * already-rendered message unless Markdown forces a remount. Kept in its own
 * file: sibling tests' mounted streamdown instances hold deferred transition
 * commits that interfere with the re-render assertions below.
 */

import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { Markdown } from '../Markdown';

vi.mock('./streamdown-plugins', async (importOriginal) => {
  const original = await importOriginal<typeof import('./streamdown-plugins')>();
  // Stable identity across renders, matching the real hook's memoized return:
  // a fresh object per call would bust streamdown's own memo on every render
  // and mask the regression this file covers.
  const stablePlugins = {};
  return { ...original, useStreamdownPlugins: () => stablePlugins };
});

const roots: Root[] = [];

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await act(async () => {
    while (roots.length > 0) roots.pop()!.unmount();
  });
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('late annotation arrival', () => {
  it('marks the passage when the annotation arrives after the message already rendered', async () => {
    const text = 'Late annotations **must mark this** passage in place.';
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      flushSync(() => {
        root.render(
          <MemoryRouter>
            <I18nProvider>
              <Markdown text={text} />
            </I18nProvider>
          </MemoryRouter>,
        );
      });
    });
    expect(container.textContent).toContain('must mark this');
    expect(container.querySelector('[data-annotation-ref]')).toBeNull();

    await act(async () => {
      flushSync(() => {
        root.render(
          <MemoryRouter>
            <I18nProvider>
              <Markdown
                text={text}
                annotationTargets={[{ id: 'ta-late', quote: 'must mark this passage', comment: null }]}
              />
            </I18nProvider>
          </MemoryRouter>,
        );
      });
    });

    const marks = container.querySelectorAll('mark[data-annotation-ref="ta-late"]');
    expect(marks.length).toBeGreaterThanOrEqual(1);
    expect(container.querySelector('span[data-annotation-ref="ta-late"]')).not.toBeNull();
  });
});

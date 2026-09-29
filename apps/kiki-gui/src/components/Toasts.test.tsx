// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { I18nProvider } from '../i18n';
import { clearToasts, pushToast } from '../lib/toasts';
import { ToastAnchor, Toasts } from './Toasts';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  clearToasts();
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  clearToasts();
});

function render(withAnchor: boolean) {
  act(() => {
    root.render(
      <I18nProvider>
        <div data-column>{withAnchor ? <ToastAnchor className="toast-anchor" /> : null}</div>
        <Toasts />
      </I18nProvider>,
    );
  });
}

describe('Toasts placement', () => {
  it('stays viewport-fixed when no column anchor is mounted', () => {
    render(false);
    act(() => { pushToast({ tone: 'success', text: 'Saved' }); });
    const stack = container.querySelector('[data-toast-stack]')!;
    expect(stack.getAttribute('data-toast-stack')).toBe('viewport');
    expect(stack.className).toContain('fixed');
  });

  it('portals into the column anchor and falls back when it unmounts', () => {
    render(true);
    act(() => { pushToast({ tone: 'success', text: 'Saved' }); });
    const anchored = container.querySelector('[data-toast-anchor] [data-toast-stack]');
    expect(anchored?.getAttribute('data-toast-stack')).toBe('anchored');
    expect(anchored?.textContent).toContain('Saved');

    render(false);
    expect(container.querySelector('[data-toast-anchor]')).toBeNull();
    expect(container.querySelector('[data-toast-stack]')?.getAttribute('data-toast-stack')).toBe('viewport');
  });
});

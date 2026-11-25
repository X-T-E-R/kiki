// @vitest-environment jsdom

import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SelectionSourceAnchor } from '@kiki/session-core/composer';
import { I18nProvider } from '../i18n';
import { SelectionQuoteButton } from './SelectionQuoteButton';

const containers: HTMLDivElement[] = [];
const roots: ReturnType<typeof createRoot>[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('navigator', { language: 'en-US' });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: 120, left: 100, right: 220, bottom: 136, width: 120, height: 16, x: 100, y: 120, toJSON: () => ({}) }),
  });
});

afterEach(async () => {
  while (roots.length > 0) {
    const r = roots.pop()!;
    await act(async () => { r.unmount(); });
  }
  for (const container of containers.splice(0)) container.remove();
  window.getSelection()?.removeAllRanges();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Harness({
  onAnnotate,
  onUpdateAnnotation,
  onRemoveAnnotation,
}: {
  onAnnotate: (text: string, comment: string, source?: SelectionSourceAnchor | null) => string;
  onUpdateAnnotation: (id: string, comment: string) => void;
  onRemoveAnnotation?: (id: string) => void;
}) {
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  return (
    <>
      <div ref={transcriptRef}>
        <p data-source>the selectable transcript text</p>
        <p data-source-secondary>another selectable transcript text</p>
      </div>
      <SelectionQuoteButton
        containerRef={transcriptRef}
        onAnnotate={onAnnotate}
        onUpdateAnnotation={onUpdateAnnotation}
        onRemoveAnnotation={onRemoveAnnotation}
      />
    </>
  );
}

async function mount() {
  let sequence = 0;
  const onAnnotate = vi.fn((_text: string, _comment: string, _source?: SelectionSourceAnchor | null) => {
    sequence += 1;
    return `annotation-${sequence}`;
  });
  const onUpdateAnnotation = vi.fn();
  const onRemoveAnnotation = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <I18nProvider>
        <Harness onAnnotate={onAnnotate} onUpdateAnnotation={onUpdateAnnotation} onRemoveAnnotation={onRemoveAnnotation} />
      </I18nProvider>,
    );
  });
  return { container, onAnnotate, onUpdateAnnotation, onRemoveAnnotation };
}

async function selectSource(container: HTMLElement, selector = '[data-source]') {
  await act(async () => {
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(container.querySelector(selector)!);
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}

function pill(): HTMLElement | null {
  return document.body.querySelector('[data-selection-quote]');
}

function annotateButton(): HTMLButtonElement {
  return pill()!.querySelector('[data-selection-annotate-action]')!;
}

function annotateInput(): HTMLTextAreaElement | null {
  return pill()?.querySelector('[data-selection-annotate-input]') ?? null;
}

async function createAnnotation() {
  await act(async () => { annotateButton().click(); });
  await act(async () => { await Promise.resolve(); });
  return annotateInput()!;
}

async function typeComment(input: HTMLTextAreaElement, text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pressKey(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

describe('SelectionQuoteButton', () => {
  it('offers one annotation entry above a contained selection', async () => {
    const { container } = await mount();
    await selectSource(container);
    expect(pill()).not.toBeNull();
    expect(pill()!.querySelectorAll('button')).toHaveLength(1);
    expect(annotateButton().textContent).toContain('Annotate');
    expect(pill()!.textContent).not.toContain('Quote');
  });

  it('creates an empty sourced item immediately and opens its multiline editor with Delete & Save buttons', async () => {
    const { container, onAnnotate, onUpdateAnnotation } = await mount();
    await selectSource(container);
    const input = await createAnnotation();
    expect(onAnnotate).toHaveBeenCalledExactlyOnceWith('the selectable transcript text', '', null);
    expect(input).not.toBeNull();
    expect(input.placeholder).toBe('Add a comment (optional)');
    expect(pill()?.querySelector('[data-annotation-panel-remove]')).not.toBeNull();
    const saveBtn = pill()?.querySelector<HTMLButtonElement>('[data-annotation-panel-save]')!;
    expect(saveBtn).not.toBeNull();
    expect(saveBtn.disabled).toBe(false);
    expect(onUpdateAnnotation).not.toHaveBeenCalled();
  });

  it('expands when focused, compresses when blurred, wraps multiline Shift+Enter, and supports Save & Delete buttons', async () => {
    const { container, onUpdateAnnotation, onRemoveAnnotation } = await mount();
    await selectSource(container);
    const input = await createAnnotation();
    expect(input.getAttribute('data-focused')).toBe('true');
    expect(input.className).toContain('min-h-[68px]');

    await act(async () => { input.blur(); });
    expect(input.getAttribute('data-focused')).toBe('false');
    expect(input.className).toContain('max-h-8');

    await act(async () => { input.focus(); });
    expect(input.getAttribute('data-focused')).toBe('true');
    await pressKey(input, 'Enter', { shiftKey: true });
    expect(pill()).not.toBeNull();

    await typeComment(input, '  worth revisiting  ');
    await act(async () => { pill()!.querySelector<HTMLButtonElement>('[data-annotation-panel-save]')!.click(); });
    expect(onUpdateAnnotation).toHaveBeenLastCalledWith('annotation-1', 'worth revisiting');
    expect(pill()).toBeNull();

    await selectSource(container, '[data-source-secondary]');
    await createAnnotation();
    await act(async () => { pill()!.querySelector<HTMLButtonElement>('[data-annotation-panel-remove]')!.click(); });
    expect(onRemoveAnnotation).toHaveBeenCalledWith('annotation-2');
    expect(pill()).toBeNull();
  });

  it('updates the same item on every comment edit; Enter only closes the box', async () => {
    const { container, onAnnotate, onUpdateAnnotation } = await mount();
    await selectSource(container);
    const input = await createAnnotation();
    await typeComment(input, 'worth revisiting');
    expect(onUpdateAnnotation).toHaveBeenLastCalledWith('annotation-1', 'worth revisiting');
    await pressKey(input, 'Enter');
    expect(onAnnotate).toHaveBeenCalledTimes(1);
    expect(pill()).toBeNull();
  });

  it('keeps an empty item when Escape or an outside click dismisses the box', async () => {
    const { container, onAnnotate, onUpdateAnnotation } = await mount();
    await selectSource(container);
    const input = await createAnnotation();
    await pressKey(input, 'Escape');
    expect(onAnnotate).toHaveBeenCalledTimes(1);
    expect(onUpdateAnnotation).not.toHaveBeenCalled();

    await selectSource(container, '[data-source-secondary]');
    const second = await createAnnotation();
    await typeComment(second, 'keep this');
    await act(async () => { document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(pill()).toBeNull();
    expect(onAnnotate).toHaveBeenCalledTimes(2);
    expect(onUpdateAnnotation).toHaveBeenLastCalledWith('annotation-2', 'keep this');
  });

  it('allows clearing a comment without recreating or removing the item', async () => {
    const { container, onAnnotate, onUpdateAnnotation } = await mount();
    await selectSource(container);
    const input = await createAnnotation();
    await typeComment(input, 'temporary');
    await typeComment(input, '');
    expect(onUpdateAnnotation).toHaveBeenLastCalledWith('annotation-1', '');
    await pressKey(input, 'Enter');
    expect(onAnnotate).toHaveBeenCalledTimes(1);
  });

  it('accumulates independent entries in selection order', async () => {
    const { container, onAnnotate } = await mount();
    await selectSource(container);
    await createAnnotation();
    await pressKey(annotateInput()!, 'Enter');
    await selectSource(container, '[data-source-secondary]');
    await createAnnotation();
    expect(onAnnotate.mock.calls.map((call) => call[0])).toEqual([
      'the selectable transcript text',
      'another selectable transcript text',
    ]);
  });

  it('keeps the comment box through selection collapse and scrolling', async () => {
    const { container } = await mount();
    await selectSource(container);
    const input = await createAnnotation();
    await typeComment(input, 'draft stays on its item');
    await act(async () => {
      window.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
      window.dispatchEvent(new Event('scroll'));
    });
    expect(annotateInput()?.value).toBe('draft stays on its item');
  });

  it('does not close or commit Enter during IME composition', async () => {
    const { container, onAnnotate, onUpdateAnnotation } = await mount();
    await selectSource(container);
    const input = await createAnnotation();
    await typeComment(input, '中文评论');
    await act(async () => { input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
    await pressKey(input, 'Enter');
    await pressKey(input, 'Escape');
    expect(annotateInput()).not.toBeNull();
    await act(async () => { input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
    await pressKey(input, 'Enter');
    expect(pill()).toBeNull();
    expect(onAnnotate).toHaveBeenCalledTimes(1);
    expect(onUpdateAnnotation).toHaveBeenLastCalledWith('annotation-1', '中文评论');
  });

  it('captures the message anchor before focusing the comment input', async () => {
    const { container, onAnnotate } = await mount();
    const source = container.querySelector<HTMLElement>('[data-source]')!;
    source.dataset['sourceBlockId'] = 'actual-source';
    source.dataset['sourceVersion'] = 'source-version';
    await selectSource(container);
    await createAnnotation();
    const text = 'theselectabletranscripttext';
    expect(onAnnotate).toHaveBeenCalledExactlyOnceWith('the selectable transcript text', '', {
      blockId: 'actual-source', version: 'source-version', start: 0, end: text.length, text,
    });
  });

  it('closes cleanly when the anchor scrolls out of the viewport', async () => {
    const originalRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
    let currentRect = { top: 200, left: 100, right: 220, bottom: 216, width: 120, height: 16, x: 100, y: 200, toJSON: () => ({}) };
    try {
      Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
        configurable: true,
        value: () => currentRect,
      });
      const { container } = await mount();
      await selectSource(container);
      await createAnnotation();
      expect(pill()).not.toBeNull();

      currentRect = { ...currentRect, top: -60, bottom: -40, y: -60 };
      await act(async () => { window.dispatchEvent(new Event('scroll')); });
      expect(pill()).toBeNull();
    } finally {
      if (originalRect !== undefined) Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalRect);
    }
  });

  it('ignores scroll events from unrelated sibling timelines (e.g. co-resident subagent panel)', async () => {
    const { container } = await mount();
    const siblingPanel = document.createElement('div');
    document.body.append(siblingPanel);
    try {
      await selectSource(container);
      expect(pill()).not.toBeNull();
      await act(async () => {
        siblingPanel.dispatchEvent(new Event('scroll', { bubbles: false }));
      });
      expect(pill()).not.toBeNull();

      await createAnnotation();
      expect(annotateInput()).not.toBeNull();
      await act(async () => {
        siblingPanel.dispatchEvent(new Event('scroll', { bubbles: false }));
      });
      expect(annotateInput()).not.toBeNull();
    } finally {
      siblingPanel.remove();
    }
  });
});

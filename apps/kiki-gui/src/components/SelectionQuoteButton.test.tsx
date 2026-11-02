// @vitest-environment jsdom

import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SelectionSourceAnchor } from '@kiki/session-core/composer';
import { I18nProvider } from '../i18n';
import { SelectionQuoteButton } from './SelectionQuoteButton';

const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('navigator', { language: 'en-US' });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: 120, left: 100, right: 220, bottom: 136, width: 120, height: 16, x: 100, y: 120, toJSON: () => ({}) }),
  });
});

afterEach(() => {
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
}: {
  onAnnotate: (text: string, comment: string, source?: SelectionSourceAnchor | null) => string;
  onUpdateAnnotation: (id: string, comment: string) => void;
}) {
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  return (
    <>
      <div ref={transcriptRef}>
        <p data-source>the selectable transcript text</p>
        <p data-source-secondary>another selectable transcript text</p>
      </div>
      <SelectionQuoteButton containerRef={transcriptRef} onAnnotate={onAnnotate} onUpdateAnnotation={onUpdateAnnotation} />
    </>
  );
}

async function mount() {
  let sequence = 0;
  const onAnnotate = vi.fn((_text: string, _comment: string, _source?: SelectionSourceAnchor | null) => { sequence += 1; return `annotation-${sequence}`; });
  const onUpdateAnnotation = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<I18nProvider><Harness onAnnotate={onAnnotate} onUpdateAnnotation={onUpdateAnnotation} /></I18nProvider>);
  });
  return { container, onAnnotate, onUpdateAnnotation };
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

function pill(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-selection-quote]');
}

function annotateButton(container: HTMLElement): HTMLButtonElement {
  return pill(container)!.querySelector('[data-selection-annotate-action]')!;
}

function annotateInput(container: HTMLElement): HTMLInputElement | null {
  return pill(container)?.querySelector('[data-selection-annotate-input]') ?? null;
}

async function createAnnotation(container: HTMLElement) {
  await act(async () => { annotateButton(container).click(); });
  return annotateInput(container)!;
}

async function typeComment(input: HTMLInputElement, text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
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
    expect(pill(container)).not.toBeNull();
    expect(pill(container)!.querySelectorAll('button')).toHaveLength(1);
    expect(annotateButton(container).textContent).toContain('Annotate');
    expect(pill(container)!.textContent).not.toContain('Quote');
  });

  it('creates an empty sourced item immediately and opens its comment box', async () => {
    const { container, onAnnotate, onUpdateAnnotation } = await mount();
    await selectSource(container);
    const input = await createAnnotation(container);
    expect(onAnnotate).toHaveBeenCalledExactlyOnceWith('the selectable transcript text', '', null);
    expect(input).not.toBeNull();
    expect(input.placeholder).toBe('Add a comment (optional)');
    expect(onUpdateAnnotation).not.toHaveBeenCalled();
  });

  it('updates the same item on every comment edit; Enter only closes the box', async () => {
    const { container, onAnnotate, onUpdateAnnotation } = await mount();
    await selectSource(container);
    const input = await createAnnotation(container);
    await typeComment(input, 'worth revisiting');
    expect(onUpdateAnnotation).toHaveBeenLastCalledWith('annotation-1', 'worth revisiting');
    await pressKey(input, 'Enter');
    expect(onAnnotate).toHaveBeenCalledTimes(1);
    expect(pill(container)).toBeNull();
  });

  it('keeps an empty item when Escape or an outside click dismisses the box', async () => {
    const { container, onAnnotate, onUpdateAnnotation } = await mount();
    await selectSource(container);
    const input = await createAnnotation(container);
    await pressKey(input, 'Escape');
    expect(onAnnotate).toHaveBeenCalledTimes(1);
    expect(onUpdateAnnotation).not.toHaveBeenCalled();

    await selectSource(container, '[data-source-secondary]');
    const second = await createAnnotation(container);
    await typeComment(second, 'keep this');
    await act(async () => { document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(pill(container)).toBeNull();
    expect(onAnnotate).toHaveBeenCalledTimes(2);
    expect(onUpdateAnnotation).toHaveBeenLastCalledWith('annotation-2', 'keep this');
  });

  it('allows clearing a comment without recreating or removing the item', async () => {
    const { container, onAnnotate, onUpdateAnnotation } = await mount();
    await selectSource(container);
    const input = await createAnnotation(container);
    await typeComment(input, 'temporary');
    await typeComment(input, '');
    expect(onUpdateAnnotation).toHaveBeenLastCalledWith('annotation-1', '');
    await pressKey(input, 'Enter');
    expect(onAnnotate).toHaveBeenCalledTimes(1);
  });

  it('accumulates independent entries in selection order', async () => {
    const { container, onAnnotate } = await mount();
    await selectSource(container);
    await createAnnotation(container);
    await pressKey(annotateInput(container)!, 'Enter');
    await selectSource(container, '[data-source-secondary]');
    await createAnnotation(container);
    expect(onAnnotate.mock.calls.map((call) => call[0])).toEqual([
      'the selectable transcript text',
      'another selectable transcript text',
    ]);
  });

  it('keeps the comment box through selection collapse and scrolling', async () => {
    const { container } = await mount();
    await selectSource(container);
    const input = await createAnnotation(container);
    await typeComment(input, 'draft stays on its item');
    await act(async () => {
      window.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
      window.dispatchEvent(new Event('scroll'));
    });
    expect(annotateInput(container)?.value).toBe('draft stays on its item');
  });

  it('does not close or commit Enter during IME composition', async () => {
    const { container, onAnnotate, onUpdateAnnotation } = await mount();
    await selectSource(container);
    const input = await createAnnotation(container);
    await typeComment(input, '中文评论');
    await act(async () => { input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
    await pressKey(input, 'Enter');
    await pressKey(input, 'Escape');
    expect(annotateInput(container)).not.toBeNull();
    await act(async () => { input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
    await pressKey(input, 'Enter');
    expect(pill(container)).toBeNull();
    expect(onAnnotate).toHaveBeenCalledTimes(1);
    expect(onUpdateAnnotation).toHaveBeenLastCalledWith('annotation-1', '中文评论');
  });

  it('captures the message anchor before focusing the comment input', async () => {
    const { container, onAnnotate } = await mount();
    const source = container.querySelector<HTMLElement>('[data-source]')!;
    source.dataset['sourceBlockId'] = 'actual-source';
    source.dataset['sourceVersion'] = 'source-version';
    await selectSource(container);
    await createAnnotation(container);
    const text = 'theselectabletranscripttext';
    expect(onAnnotate).toHaveBeenCalledExactlyOnceWith('the selectable transcript text', '', {
      blockId: 'actual-source', version: 'source-version', start: 0, end: text.length, text,
    });
  });
});

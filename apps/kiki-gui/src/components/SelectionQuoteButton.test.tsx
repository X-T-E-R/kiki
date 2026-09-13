// @vitest-environment jsdom

import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { SelectionQuoteButton } from './SelectionQuoteButton';

const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  // Copy assertions are English: pin the locale source (Node's built-in
  // navigator reports the OS language).
  vi.stubGlobal('navigator', { language: 'en-US' });
  // jsdom ranges have no geometry at all; the popover needs a real anchor rect.
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      top: 120,
      left: 100,
      right: 220,
      bottom: 136,
      width: 120,
      height: 16,
      x: 100,
      y: 120,
      toJSON: () => ({}),
    }),
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
  onQuote,
  onAnnotate,
}: {
  onQuote: (text: string) => void;
  onAnnotate: (text: string, comment: string) => void;
}) {
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  return (
    <>
      <div ref={transcriptRef}>
        <p data-source>the selectable transcript text</p>
        <p data-source-secondary>another selectable transcript text</p>
      </div>
      <SelectionQuoteButton containerRef={transcriptRef} onQuote={onQuote} onAnnotate={onAnnotate} />
    </>
  );
}

async function mount(onQuote = vi.fn(), onAnnotate = vi.fn()) {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider>
        <Harness onQuote={onQuote} onAnnotate={onAnnotate} />
      </I18nProvider>,
    );
  });
  return { container, onQuote, onAnnotate };
}

/** Selects a fixture paragraph and fires the mouseup that opens the pill. */
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

function quoteButton(container: HTMLElement): HTMLButtonElement {
  return pill(container)!.querySelector('button')!;
}

function annotateButton(container: HTMLElement): HTMLButtonElement {
  return pill(container)!.querySelector('[data-selection-annotate-action]')!;
}

function annotateInput(container: HTMLElement): HTMLInputElement | null {
  return pill(container)?.querySelector('[data-selection-annotate-input]') ?? null;
}

/** Types into the controlled comment input (native setter + input event). */
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
  it('offers both quote and annotate actions above a contained selection', async () => {
    const { container } = await mount();
    await selectSource(container);
    expect(pill(container)).not.toBeNull();
    expect(quoteButton(container).textContent).toContain('Quote');
    expect(annotateButton(container).textContent).toContain('Annotate');
  });

  it('quotes the selection and dismisses the pill', async () => {
    const onQuote = vi.fn();
    const { container } = await mount(onQuote);
    await selectSource(container);
    await act(async () => { quoteButton(container).click(); });
    expect(onQuote).toHaveBeenCalledWith('the selectable transcript text');
    expect(pill(container)).toBeNull();
    expect(window.getSelection()!.rangeCount).toBe(0);
  });

  it('annotate swaps to the comment input; Enter commits text + comment', async () => {
    const onAnnotate = vi.fn();
    const { container } = await mount(vi.fn(), onAnnotate);
    await selectSource(container);
    await act(async () => { annotateButton(container).click(); });
    const input = annotateInput(container);
    expect(input).not.toBeNull();
    expect(input!.placeholder).toContain('Enter');
    await typeComment(input!, '  worth revisiting  ');
    await pressKey(input!, 'Enter');
    expect(onAnnotate).toHaveBeenCalledWith('the selectable transcript text', 'worth revisiting');
    expect(pill(container)).toBeNull();
    expect(window.getSelection()!.rangeCount).toBe(0);
  });

  it('Escape in the input falls back to the two actions without committing', async () => {
    const onAnnotate = vi.fn();
    const { container } = await mount(vi.fn(), onAnnotate);
    await selectSource(container);
    await act(async () => { annotateButton(container).click(); });
    const input = annotateInput(container)!;
    await typeComment(input, 'half-written note');
    await pressKey(input, 'Escape');
    expect(onAnnotate).not.toHaveBeenCalled();
    expect(annotateInput(container)).toBeNull();
    expect(quoteButton(container).textContent).toContain('Quote');
  });

  it('Enter with an empty comment commits nothing and keeps the input open', async () => {
    const onAnnotate = vi.fn();
    const { container } = await mount(vi.fn(), onAnnotate);
    await selectSource(container);
    await act(async () => { annotateButton(container).click(); });
    const input = annotateInput(container)!;
    await pressKey(input, 'Enter');
    expect(onAnnotate).not.toHaveBeenCalled();
    expect(annotateInput(container)).not.toBeNull();
  });

  it('a collapsed selection does not hide the open annotate input or draft', async () => {
    const { container } = await mount();
    await selectSource(container);
    await act(async () => { annotateButton(container).click(); });
    const input = annotateInput(container)!;
    await typeComment(input, 'draft survives collapse');
    // Focusing the input collapses the document selection — the popover must
    // survive because the text is already captured.
    await act(async () => {
      window.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(annotateInput(container)?.value).toBe('draft survives collapse');
  });

  it('does not prevent an input mousedown from placing the caret', async () => {
    const { container } = await mount();
    await selectSource(container);
    await act(async () => { annotateButton(container).click(); });
    const input = annotateInput(container)!;
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    await act(async () => {
      input.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });

  it('keeps a long annotation draft through transcript and input scrolling', async () => {
    const onAnnotate = vi.fn();
    const { container } = await mount(vi.fn(), onAnnotate);
    await selectSource(container);
    await act(async () => { annotateButton(container).click(); });
    const input = annotateInput(container)!;
    const longComment = 'long note '.repeat(400);
    await typeComment(input, longComment);
    await act(async () => {
      input.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(annotateInput(container)?.value).toBe(longComment);
    await act(async () => {
      window.dispatchEvent(new Event('scroll'));
    });
    const retainedInput = annotateInput(container);
    expect(retainedInput).not.toBeNull();
    expect(retainedInput!.value).toBe(longComment);
    await pressKey(retainedInput!, 'Enter');
    expect(onAnnotate).toHaveBeenCalledTimes(1);
    expect(onAnnotate).toHaveBeenCalledWith('the selectable transcript text', longComment.trim());
  });

  it('temporarily hides on an outside click and reopens the draft on the same selection', async () => {
    const onAnnotate = vi.fn();
    const { container } = await mount(vi.fn(), onAnnotate);
    await selectSource(container);
    await act(async () => { annotateButton(container).click(); });
    const input = annotateInput(container)!;
    await typeComment(input, 'half-written note');
    await act(async () => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(annotateInput(container)).toBeNull();

    await selectSource(container);
    const resumedInput = annotateInput(container);
    expect(resumedInput).not.toBeNull();
    expect(resumedInput!.value).toBe('half-written note');
    await pressKey(resumedInput!, 'Enter');
    expect(onAnnotate).toHaveBeenCalledTimes(1);
    expect(pill(container)).toBeNull();
  });

  it('shows actions for a different selection without losing the original draft', async () => {
    const onQuote = vi.fn();
    const { container } = await mount(onQuote);
    await selectSource(container);
    await act(async () => { annotateButton(container).click(); });
    await typeComment(annotateInput(container)!, 'keep this draft');
    await act(async () => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    await selectSource(container, '[data-source-secondary]');
    expect(quoteButton(container).textContent).toContain('Quote');
    await act(async () => { quoteButton(container).click(); });
    expect(onQuote).toHaveBeenCalledWith('another selectable transcript text');

    await selectSource(container);
    await act(async () => { annotateButton(container).click(); });
    expect(annotateInput(container)?.value).toBe('keep this draft');
  });

  it('starts a fresh annotation for a different selection instead of reusing its draft', async () => {
    const onAnnotate = vi.fn();
    const { container } = await mount(vi.fn(), onAnnotate);
    await selectSource(container);
    await act(async () => { annotateButton(container).click(); });
    await typeComment(annotateInput(container)!, 'old source note');
    await act(async () => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    await selectSource(container, '[data-source-secondary]');
    await act(async () => { annotateButton(container).click(); });
    expect(annotateInput(container)?.value).toBe('');
    await typeComment(annotateInput(container)!, 'new source note');
    await pressKey(annotateInput(container)!, 'Enter');
    expect(onAnnotate).toHaveBeenCalledTimes(1);
    expect(onAnnotate).toHaveBeenCalledWith('another selectable transcript text', 'new source note');
  });

  it('allows a second annotation after a successful submit', async () => {
    const onAnnotate = vi.fn();
    const { container } = await mount(vi.fn(), onAnnotate);
    await selectSource(container);
    await act(async () => { annotateButton(container).click(); });
    await typeComment(annotateInput(container)!, 'first note');
    await pressKey(annotateInput(container)!, 'Enter');
    expect(onAnnotate).toHaveBeenCalledTimes(1);

    await selectSource(container, '[data-source-secondary]');
    await act(async () => { annotateButton(container).click(); });
    expect(annotateInput(container)?.value).toBe('');
    await typeComment(annotateInput(container)!, 'second note');
    await pressKey(annotateInput(container)!, 'Enter');
    expect(onAnnotate).toHaveBeenCalledTimes(2);
    expect(onAnnotate).toHaveBeenLastCalledWith('another selectable transcript text', 'second note');
  });

  it('does not commit Enter while an IME composition is active and commits once after it ends', async () => {
    const onAnnotate = vi.fn();
    const { container } = await mount(vi.fn(), onAnnotate);
    await selectSource(container);
    await act(async () => { annotateButton(container).click(); });
    const input = annotateInput(container)!;
    await typeComment(input, '中文草稿');
    await act(async () => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    await pressKey(input, 'Enter');
    expect(onAnnotate).not.toHaveBeenCalled();
    expect(annotateInput(container)?.value).toBe('中文草稿');
    await act(async () => {
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    await pressKey(input, 'Enter');
    expect(onAnnotate).toHaveBeenCalledTimes(1);
    await pressKey(input, 'Enter');
    expect(onAnnotate).toHaveBeenCalledTimes(1);
  });

  it('clears a temporarily retained draft only after explicit Escape cancellation', async () => {
    const { container } = await mount();
    await selectSource(container);
    await act(async () => { annotateButton(container).click(); });
    await typeComment(annotateInput(container)!, 'discard me');
    await act(async () => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await pressKey(document.body, 'Escape');
    await selectSource(container);
    expect(annotateInput(container)).toBeNull();
    await act(async () => { annotateButton(container).click(); });
    expect(annotateInput(container)?.value).toBe('');
  });
});

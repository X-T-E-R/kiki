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

/** Selects the fixture paragraph and fires the mouseup that opens the pill. */
async function selectSource(container: HTMLElement) {
  await act(async () => {
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(container.querySelector('[data-source]')!);
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

async function pressKey(target: HTMLElement, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
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

  it('a collapsed selection does not hide the open annotate input', async () => {
    const { container } = await mount();
    await selectSource(container);
    await act(async () => { annotateButton(container).click(); });
    // Focusing the input collapses the document selection — the popover must
    // survive because the text is already captured.
    await act(async () => {
      window.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(annotateInput(container)).not.toBeNull();
  });
});

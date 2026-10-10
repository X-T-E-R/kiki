// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  annotationOverrideId,
  getAnnotationOverridesSnapshot,
  resetAnnotationOverridesForTests,
} from '@kiki/session-core/composer';
import { I18nProvider } from '../i18n';
import { notePreviewText, SentAnnotationsBubble } from './SentAnnotationsBubble';

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
const mounted: { root: Root; container: HTMLDivElement }[] = [];

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
    container.remove();
  }
  resetAnnotationOverridesForTests();
  vi.useRealTimers();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function renderBubble(
  blockId: string,
  annotations: readonly { quote: string; comment: string }[],
  locale: 'en' | 'zh' = 'en',
) {
  if (locale === 'zh') {
    localStorage.setItem('kiki.locale', 'zh');
  } else {
    localStorage.setItem('kiki.locale', 'en');
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <I18nProvider>
        <SentAnnotationsBubble blockId={blockId} annotations={annotations} />
      </I18nProvider>,
    );
  });
  return container;
}

async function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('notePreviewText', () => {
  it('preserves short comments unmodified', () => {
    expect(notePreviewText('Short')).toBe('Short');
    expect(notePreviewText('短批注')).toBe('短批注');
  });

  it('flattens newlines and redundant spaces into one line', () => {
    expect(notePreviewText('A\nB')).toBe('A B');
    expect(notePreviewText('  Hi   all  ')).toBe('Hi all');
  });

  it('truncates at 7 code points with an ellipsis', () => {
    // 7 chars exactly
    expect(notePreviewText('1234567')).toBe('1234567');
    // 8 chars -> truncated to 7 + ellipsis
    expect(notePreviewText('12345678')).toBe('1234567…');
    // Chinese characters
    expect(notePreviewText('一二三四五六七')).toBe('一二三四五六七');
    expect(notePreviewText('一二三四五六七八')).toBe('一二三四五六七…');
  });
});

describe('SentAnnotationsBubble rendering forms', () => {
  it('renders nothing when annotations are empty', async () => {
    const container = await renderBubble('block-empty', []);
    expect(container.querySelector('[data-annotation-bubble]')).toBeNull();
  });

  it('renders 1 individual bubble with preview for single annotation', async () => {
    const container = await renderBubble('block-1', [
      { quote: 'quote text', comment: 'Keep floor batching explicit' },
    ]);
    const buttons = container.querySelectorAll<HTMLButtonElement>('[data-annotation-bubble="block-1"]');
    expect(buttons.length).toBe(1);
    expect(buttons[0]!.textContent).toContain('Keep fl…');
    expect(buttons[0]!.getAttribute('title')).toBe('Keep floor batching explicit');
    expect(buttons[0]!.getAttribute('aria-label')).toBe('Open note on “quote text”');
  });

  it('renders 3 individual bubbles with previews for 3 annotations (<= 3)', async () => {
    const container = await renderBubble('block-3', [
      { quote: 'first quote', comment: 'Note A' },
      { quote: 'second quote', comment: 'Note B is slightly longer' },
      { quote: 'third quote', comment: '第三条中文详细批注说明' },
    ]);
    const buttons = container.querySelectorAll<HTMLButtonElement>('[data-annotation-bubble="block-3"]');
    expect(buttons.length).toBe(3);
    expect(buttons[0]!.textContent).toContain('Note A');
    expect(buttons[1]!.textContent).toContain('Note B …');
    expect(buttons[2]!.textContent).toContain('第三条中文详细…');
  });

  it('collapses into a single merged bubble with count for > 3 annotations (en)', async () => {
    const container = await renderBubble(
      'block-many-en',
      [
        { quote: 'q1', comment: 'c1' },
        { quote: 'q2', comment: 'c2' },
        { quote: 'q3', comment: 'c3' },
        { quote: 'q4', comment: 'c4' },
      ],
      'en',
    );
    const buttons = container.querySelectorAll<HTMLButtonElement>('[data-annotation-bubble="block-many-en"]');
    expect(buttons.length).toBe(1);
    expect(buttons[0]!.textContent).toContain('4 annotations');
    expect(buttons[0]!.getAttribute('aria-label')).toBe('View the 4 notes on this message');
  });

  it('collapses into a single merged bubble with count for > 3 annotations (zh: n 个标注)', async () => {
    const container = await renderBubble(
      'block-many-zh',
      [
        { quote: 'q1', comment: 'c1' },
        { quote: 'q2', comment: 'c2' },
        { quote: 'q3', comment: 'c3' },
        { quote: 'q4', comment: 'c4' },
        { quote: 'q5', comment: 'c5' },
      ],
      'zh',
    );
    const buttons = container.querySelectorAll<HTMLButtonElement>('[data-annotation-bubble="block-many-zh"]');
    expect(buttons.length).toBe(1);
    expect(buttons[0]!.textContent).toContain('5 个标注');
    expect(buttons[0]!.getAttribute('aria-label')).toBe('查看这条消息带有的 5 条批注');
  });

  it('opens popover when clicking individual bubble', async () => {
    const container = await renderBubble('block-click-indiv', [
      { quote: 'target quote', comment: 'Detailed comment' },
    ]);
    const button = container.querySelector<HTMLButtonElement>('[data-annotation-bubble="block-click-indiv"]')!;
    expect(document.body.querySelector('[data-annotation-bubble-panel]')).toBeNull();

    await act(async () => { button.click(); });
    const panel = document.body.querySelector<HTMLElement>('[data-annotation-bubble-panel]')!;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain('target quote');
    expect(panel.textContent).toContain('Detailed comment');
  });

  it('keeps multiline quote and comment fully readable in the scrollable popover', async () => {
    const blockId = 'block-multiline-read';
    const quote = 'First quoted line\nsecond quoted line';
    const comment = 'First note line\n  second note line';
    const container = await renderBubble(blockId, [{ quote, comment }]);
    const button = container.querySelector<HTMLButtonElement>(`[data-annotation-bubble="${blockId}"]`)!;

    await act(async () => { button.click(); });
    const panel = document.body.querySelector<HTMLElement>('[data-annotation-bubble-panel]')!;
    const quoteSpan = panel.querySelector<HTMLElement>('[data-annotation-bubble-quote]')!;
    const commentSpan = panel.querySelector<HTMLElement>('[data-annotation-bubble-comment]')!;
    const quoteParagraph = quoteSpan.closest('p')!;

    expect(quoteSpan.textContent).toBe(quote);
    expect(quoteSpan.className).toContain('whitespace-pre-wrap');
    expect(quoteParagraph.className).not.toContain('max-h-16');
    expect(quoteParagraph.className).not.toContain('overflow-hidden');
    expect(commentSpan.textContent).toBe(comment);
    expect(commentSpan.className).toContain('whitespace-pre-wrap');
    expect(panel.querySelector('ul')?.className).toContain('overflow-y-auto');
  });

  it('edits multiline comments with modifier commit and IME-safe cancel semantics', async () => {
    const blockId = 'block-multiline-edit';
    const quote = 'A quoted line';
    const originalComment = 'Original first line\nOriginal second line';
    const container = await renderBubble(blockId, [{ quote, comment: originalComment }]);
    const noteId = annotationOverrideId(quote, originalComment, blockId, 0);
    const button = container.querySelector<HTMLButtonElement>(`[data-annotation-bubble="${blockId}"]`)!;

    await act(async () => { button.click(); });
    let panel = document.body.querySelector<HTMLElement>('[data-annotation-bubble-panel]')!;
    await act(async () => { panel.querySelector<HTMLButtonElement>('[data-annotation-bubble-edit]')!.click(); });
    let textarea = panel.querySelector<HTMLTextAreaElement>('[data-annotation-bubble-input]')!;
    expect(textarea).not.toBeNull();
    expect(textarea.value).toBe(originalComment);

    const ctrlValue = 'Edited first line\n  Edited second line';
    await setTextareaValue(textarea, ctrlValue);
    const newline = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' });
    await act(async () => { textarea.dispatchEvent(newline); });
    expect(newline.defaultPrevented).toBe(false);
    expect(textarea.value).toBe(ctrlValue);
    expect(getAnnotationOverridesSnapshot()[noteId]).toBeUndefined();

    await act(async () => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    const composingCommit = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: 'Enter',
    });
    await act(async () => { textarea.dispatchEvent(composingCommit); });
    expect(composingCommit.defaultPrevented).toBe(false);
    expect(textarea.isConnected).toBe(true);
    await act(async () => {
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });

    const ctrlCommit = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: 'Enter',
    });
    await act(async () => { textarea.dispatchEvent(ctrlCommit); });
    expect(ctrlCommit.defaultPrevented).toBe(true);
    expect(getAnnotationOverridesSnapshot()[noteId]?.comment).toBe(ctrlValue);
    expect(document.body.querySelector('[data-annotation-bubble-input]')).toBeNull();

    panel = document.body.querySelector<HTMLElement>('[data-annotation-bubble-panel]')!;
    await act(async () => { panel.querySelector<HTMLButtonElement>('[data-annotation-bubble-edit]')!.click(); });
    textarea = panel.querySelector<HTMLTextAreaElement>('[data-annotation-bubble-input]')!;
    const metaValue = `${ctrlValue}\nMeta committed line`;
    await setTextareaValue(textarea, metaValue);
    const metaCommit = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      metaKey: true,
    });
    await act(async () => { textarea.dispatchEvent(metaCommit); });
    expect(metaCommit.defaultPrevented).toBe(true);
    expect(getAnnotationOverridesSnapshot()[noteId]?.comment).toBe(metaValue);

    panel = document.body.querySelector<HTMLElement>('[data-annotation-bubble-panel]')!;
    await act(async () => { panel.querySelector<HTMLButtonElement>('[data-annotation-bubble-edit]')!.click(); });
    textarea = panel.querySelector<HTMLTextAreaElement>('[data-annotation-bubble-input]')!;
    await setTextareaValue(textarea, 'Discarded line\nDiscarded detail');
    const escape = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' });
    await act(async () => { textarea.dispatchEvent(escape); });
    expect(escape.defaultPrevented).toBe(true);
    expect(panel.querySelector('[data-annotation-bubble-input]')).toBeNull();
    expect(getAnnotationOverridesSnapshot()[noteId]?.comment).toBe(metaValue);
    expect(panel.querySelector<HTMLElement>('[data-annotation-bubble-comment]')?.textContent).toBe(metaValue);
  });

  it('opens popover when clicking merged bubble', async () => {
    const container = await renderBubble('block-click-merged', [
      { quote: 'quote 1', comment: 'Comment 1' },
      { quote: 'quote 2', comment: 'Comment 2' },
      { quote: 'quote 3', comment: 'Comment 3' },
      { quote: 'quote 4', comment: 'Comment 4' },
    ]);
    const button = container.querySelector<HTMLButtonElement>('[data-annotation-bubble="block-click-merged"]')!;
    expect(document.body.querySelector('[data-annotation-bubble-panel]')).toBeNull();

    await act(async () => { button.click(); });
    const panel = document.body.querySelector<HTMLElement>('[data-annotation-bubble-panel]')!;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain('quote 1');
    expect(panel.textContent).toContain('quote 4');
  });
});

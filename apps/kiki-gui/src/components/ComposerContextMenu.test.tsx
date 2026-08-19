// @vitest-environment jsdom

import { useRef, useState, type MouseEvent } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { useComposerContextMenu } from './ComposerContextMenu';

const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
  vi.restoreAllMocks();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});

/** Clipboard mock: writeText records the written string; readText returns the staged text. */
function mockClipboard(nextRead = '') {
  const written: string[] = [];
  const clipboard = {
    writeText: vi.fn((text: string) => {
      written.push(text);
      return Promise.resolve();
    }),
    readText: vi.fn(() => Promise.resolve(nextRead)),
  };
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    get: () => clipboard,
  });
  return { clipboard, written };
}

function Harness({ onPaste }: { onPaste?: (text: string) => void }) {
  const [value, setValue] = useState('hello world');
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const { onContextMenu, menu } = useComposerContextMenu({
    textareaRef: ref,
    onChange: setValue,
    onPastePlainText: onPaste,
  });
  return (
    <>
      <textarea
        ref={ref}
        value={value}
        onChange={(event) => { setValue(event.target.value); }}
        onContextMenu={onContextMenu}
        data-testarea
      />
      {menu}
    </>
  );
}

async function mount(onPaste?: (text: string) => void) {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider>
        <Harness onPaste={onPaste} />
      </I18nProvider>,
    );
  });
  return { container, root };
}

async function openMenu(container: HTMLDivElement, selectStart: number, selectEnd: number) {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
  // Wait one tick so the clipboard-supported effect settles.
  await act(async () => { await Promise.resolve(); });
  textarea.focus();
  textarea.setSelectionRange(selectStart, selectEnd);
  await act(async () => {
    textarea.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }),
    );
  });
}

describe('useComposerContextMenu', () => {
  it('renders the four actions and disables cut/copy with no selection', async () => {
    mockClipboard('');
    const { container } = await mount();
    await openMenu(container, 3, 3);

    const menu = container.querySelector('[data-composer-context-menu]');
    expect(menu).not.toBeNull();
    const labels = Array.from(menu!.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent);
    expect(labels).toEqual(['Cut', 'Copy', 'Paste as plain text', 'Select all']);

    const cut = menu!.querySelector('[data-menu-action="cut"]') as HTMLButtonElement;
    const copy = menu!.querySelector('[data-menu-action="copy"]') as HTMLButtonElement;
    expect(cut.disabled).toBe(true);
    expect(copy.disabled).toBe(true);
    // Paste is enabled even with a caret; select-all enabled when there is content.
    expect((menu!.querySelector('[data-menu-action="paste"]') as HTMLButtonElement).disabled).toBe(false);
    expect((menu!.querySelector('[data-menu-action="select-all"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('copies the selected slice and closes the menu', async () => {
    const { clipboard, written } = mockClipboard('');
    const { container } = await mount();
    await openMenu(container, 6, 11); // "world"

    const copy = container.querySelector('[data-menu-action="copy"]') as HTMLButtonElement;
    expect(copy.disabled).toBe(false);
    await act(async () => { copy.click(); await Promise.resolve(); });

    expect(written).toEqual(['world']);
    expect(container.querySelector('[data-composer-context-menu]')).toBeNull();
    expect(clipboard.writeText).toHaveBeenCalledWith('world');
  });

  it('does not fall through to the native menu when the clipboard API is present', async () => {
    mockClipboard('pasted');
    const { container } = await mount();
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => { await Promise.resolve(); });
    textarea.focus();
    textarea.setSelectionRange(0, 5);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    await act(async () => { textarea.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('useComposerContextMenu clipping behaviours', () => {
  it('cut removes the selection and stages the text on the clipboard', async () => {
    const { written } = mockClipboard('');
    const { container } = await mount();
    await openMenu(container, 0, 5); // "hello"

    const cut = container.querySelector('[data-menu-action="cut"]') as HTMLButtonElement;
    await act(async () => { cut.click(); await Promise.resolve(); });

    expect(written).toEqual(['hello']);
    expect(container.querySelector('textarea')!.value).toBe(' world');
  });

  it('paste inserts plain text into the pinned range', async () => {
    mockClipboard('PASTED');
    const { container } = await mount();
    await openMenu(container, 6, 11); // select "world"

    const paste = container.querySelector('[data-menu-action="paste"]') as HTMLButtonElement;
    await act(async () => { paste.click(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.querySelector('textarea')!.value).toBe('hello PASTED');
  });

  it('select-all selects the whole value', async () => {
    mockClipboard('');
    const { container } = await mount();
    await openMenu(container, 0, 0);

    const selectAll = container.querySelector('[data-menu-action="select-all"]') as HTMLButtonElement;
    await act(async () => { selectAll.click(); });

    const textarea = container.querySelector('textarea')!;
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe(textarea.value.length);
  });
});
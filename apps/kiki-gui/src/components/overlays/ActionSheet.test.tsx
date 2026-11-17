// @vitest-environment jsdom

import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionSheet } from './ActionSheet';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

function pressKey(target: EventTarget, key: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('ActionSheet', () => {
  it('defaults to role="menu", focuses the first enabled menuitem, and restores focus to the opener on Escape', async () => {
    function MenuHarness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" data-opener onClick={() => { setOpen(true); }}>
            More
          </button>
          {open ? (
            <ActionSheet
              ariaLabel="More actions"
              overlayId="test-action-menu"
              dataAttribute="data-test-sheet"
              onClose={() => { setOpen(false); }}
            >
              <button type="button" role="menuitem" disabled data-item="disabled">Disabled</button>
              <button type="button" role="menuitem" data-item="first">First</button>
              <button type="button" role="menuitem" data-item="second">Second</button>
            </ActionSheet>
          ) : null}
        </div>
      );
    }

    act(() => { root.render(<MenuHarness />); });
    const opener = container.querySelector<HTMLButtonElement>('[data-opener]')!;
    opener.focus();
    await act(async () => { opener.click(); });

    const sheet = document.body.querySelector<HTMLElement>('.kiki-action-sheet')!;
    expect(sheet.getAttribute('role')).toBe('menu');
    const first = sheet.querySelector<HTMLElement>('[data-item="first"]')!;
    const second = sheet.querySelector<HTMLElement>('[data-item="second"]')!;
    expect(document.activeElement).toBe(first);

    await act(async () => { pressKey(first, 'ArrowDown'); });
    expect(document.activeElement).toBe(second);

    await act(async () => { pressKey(second, 'Escape'); });
    await act(async () => { await Promise.resolve(); });
    expect(document.body.querySelector('[data-test-sheet]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('supports role="dialog" with autofocus=false by focusing the sheet container instead of leaving focus on the opener', async () => {
    const onSelect = vi.fn();

    function DialogSheetHarness() {
      const [open, setOpen] = useState(false);
      const [activeIndex, setActiveIndex] = useState(0);
      const options = ['Model A', 'Model B'];
      return (
        <div>
          <button
            type="button"
            data-add-filter
            onClick={() => { setOpen((prev) => !prev); }}
          >
            + Filter
          </button>
          {open ? (
            <ActionSheet
              id="filter-sheet"
              role="dialog"
              ariaLabel="Filters"
              overlayId="filter-sheet"
              dataAttribute="data-filter-sheet"
              autofocus={false}
              onClose={() => { setOpen(false); }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActiveIndex((i) => (i + 1) % options.length);
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  onSelect(options[activeIndex]);
                }
              }}
            >
              <input type="text" data-search aria-label="Search" />
              <div role="listbox">
                {options.map((opt) => (
                  <button key={opt} type="button" role="option" aria-selected={false}>
                    {opt}
                  </button>
                ))}
              </div>
            </ActionSheet>
          ) : null}
        </div>
      );
    }

    act(() => { root.render(<DialogSheetHarness />); });
    const trigger = container.querySelector<HTMLButtonElement>('[data-add-filter]')!;
    trigger.focus();
    await act(async () => { trigger.click(); });

    const sheet = document.body.querySelector<HTMLElement>('#filter-sheet')!;
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(sheet.getAttribute('tabindex')).toBe('-1');
    // Initial focus moves off the underlying + Filter trigger onto the sheet container.
    expect(document.activeElement).toBe(sheet);
    expect(document.activeElement).not.toBe(trigger);

    // ArrowDown + Enter on the focused sheet drives the dialog's listbox handler without closing.
    await act(async () => { pressKey(document.activeElement!, 'ArrowDown'); });
    await act(async () => { pressKey(document.activeElement!, 'Enter'); });
    expect(onSelect).toHaveBeenCalledWith('Model B');
    expect(document.body.querySelector('[data-filter-sheet]')).not.toBeNull();
  });

  it('falls back to returnFocusRef when the original opener unmounts before close', async () => {
    function FallbackFocusHarness() {
      const [open, setOpen] = useState(false);
      const [hasChip, setHasChip] = useState(true);
      const fallbackRef = useRef<HTMLButtonElement>(null);
      return (
        <div>
          <button ref={fallbackRef} type="button" data-fallback>
            + Filter
          </button>
          {hasChip ? (
            <button type="button" data-chip onClick={() => { setOpen(true); }}>
              Model: K2
            </button>
          ) : null}
          {open ? (
            <ActionSheet
              role="dialog"
              ariaLabel="Filters"
              overlayId="fallback-sheet"
              autofocus={false}
              returnFocusRef={fallbackRef}
              onClose={() => { setOpen(false); }}
            >
              <button type="button" data-remove-chip onClick={() => { setHasChip(false); }}>
                Remove chip
              </button>
            </ActionSheet>
          ) : null}
        </div>
      );
    }

    act(() => { root.render(<FallbackFocusHarness />); });
    const fallback = container.querySelector<HTMLButtonElement>('[data-fallback]')!;
    const chip = container.querySelector<HTMLButtonElement>('[data-chip]')!;
    chip.focus();
    await act(async () => { chip.click(); });

    const removeBtn = document.body.querySelector<HTMLButtonElement>('[data-remove-chip]')!;
    await act(async () => { removeBtn.click(); });
    expect(container.querySelector('[data-chip]')).toBeNull();

    await act(async () => { pressKey(document.body, 'Escape'); });
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(fallback);
  });
});

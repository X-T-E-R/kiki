// @vitest-environment jsdom

/**
 * MiniContextMenu focus management: focus moves into the menu on open, arrows
 * cycle the items, Escape and item activation hand focus back to whatever was
 * focused before — while an outside pointerdown never steals focus back, an
 * action that opens a dialog keeps the dialog's own focus, and a trigger that
 * unmounted while the menu was open is skipped rather than sending focus to a
 * stranger. jsdom proves the DOM focus logic only, not real screen-reader or
 * platform key behavior.
 */

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Dialog } from './Dialog';
import { MiniContextMenu, type MiniMenuEntry } from './MiniContextMenu';
import { anyOverlayOpen } from '../lib/uiBusy';
import { clearToasts } from '../lib/toasts';

const ENTRIES: MiniMenuEntry[] = [
  { key: 'first', label: 'First', run: vi.fn() },
  { separator: true },
  { key: 'second', label: 'Second', run: vi.fn() },
  { key: 'third', label: 'Third', run: vi.fn() },
];

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  clearToasts();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

function Harness({
  entries = ENTRIES,
  onClose = () => undefined,
}: {
  entries?: MiniMenuEntry[];
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-trigger onClick={() => { setOpen(true); }}>
        open menu
      </button>
      {open ? (
        <MiniContextMenu
          x={10}
          y={10}
          entries={entries}
          onClose={() => {
            setOpen(false);
            onClose();
          }}
          ariaLabel="Test menu"
          overlayId="test-menu"
          dataAttribute="data-test-menu"
        />
      ) : null}
    </>
  );
}

async function render(node: React.ReactNode) {
  await act(async () => root.render(node));
}
async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}
async function keydown(target: Element | Window, key: string) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
}

const menu = () => document.body.querySelector<HTMLElement>('[data-test-menu]');
const items = () => [...(menu()?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
const trigger = () => document.body.querySelector<HTMLButtonElement>('[data-trigger]')!;

async function openFromTrigger(): Promise<void> {
  const node = trigger();
  await act(async () => { node.focus(); });
  await click(node);
}

describe('MiniContextMenu focus', () => {
  it('moves focus to the first item on open and registers as an overlay', async () => {
    await render(<Harness />);
    expect(anyOverlayOpen()).toBe(false);
    await openFromTrigger();
    expect(menu()).not.toBeNull();
    expect(anyOverlayOpen()).toBe(true);
    expect(document.activeElement).toBe(items()[0]);
    expect(items().map((item) => item.textContent)).toEqual(['First', 'Second', 'Third']);
  });

  it('cycles items with ArrowDown/ArrowUp and jumps with Home/End', async () => {
    await render(<Harness />);
    await openFromTrigger();
    await keydown(items()[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(items()[1]);
    // The separator between First and Second never takes focus.
    await keydown(items()[1]!, 'ArrowDown');
    expect(document.activeElement).toBe(items()[2]);
    await keydown(items()[2]!, 'ArrowDown');
    expect(document.activeElement).toBe(items()[0]);
    await keydown(items()[0]!, 'ArrowUp');
    expect(document.activeElement).toBe(items()[2]);
    await keydown(items()[2]!, 'Home');
    expect(document.activeElement).toBe(items()[0]);
    await keydown(items()[0]!, 'End');
    expect(document.activeElement).toBe(items()[2]);
  });

  it('Escape closes and hands focus back to the trigger', async () => {
    const onClose = vi.fn();
    await render(<Harness onClose={onClose} />);
    await openFromTrigger();
    await keydown(window, 'Escape');
    expect(menu()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger());
    expect(anyOverlayOpen()).toBe(false);
  });

  it('item activation runs the entry and returns focus to the trigger', async () => {
    const run = vi.fn();
    await render(<Harness entries={[{ key: 'act', label: 'Act', run }]} />);
    await openFromTrigger();
    expect(document.activeElement).toBe(items()[0]);
    await click(document.activeElement as Element);
    expect(run).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('an outside pointerdown closes without pulling focus back to the trigger', async () => {
    await render(
      <>
        <Harness />
        <button type="button" data-elsewhere>elsewhere</button>
      </>,
    );
    await openFromTrigger();
    expect(menu()).not.toBeNull();
    const elsewhere = document.body.querySelector('[data-elsewhere]')!;
    await act(async () => { elsewhere.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    expect(menu()).toBeNull();
    // The menu did not yank focus back to its opener; whatever the pointer
    // lands on keeps its own focus course (jsdom: nothing claims it).
    expect(document.activeElement).not.toBe(trigger());
  });

  it('an action that opens a dialog leaves focus inside that dialog', async () => {
    function DialogHarness() {
      const [open, setOpen] = useState(false);
      const [dialog, setDialog] = useState(false);
      return (
        <>
          <button type="button" data-trigger onClick={() => { setOpen(true); }}>
            open menu
          </button>
          {open ? (
            <MiniContextMenu
              x={10}
              y={10}
              entries={[{ key: 'open-dialog', label: 'Open dialog', run: () => { setDialog(true); } }]}
              onClose={() => { setOpen(false); }}
              ariaLabel="Test menu"
              overlayId="test-menu"
              dataAttribute="data-test-menu"
            />
          ) : null}
          {dialog ? (
            <Dialog ariaLabel="Follow-up" overlayId="follow-up-dialog" onClose={() => { setDialog(false); }}>
              <input data-autofocus aria-label="Follow-up field" />
            </Dialog>
          ) : null}
        </>
      );
    }
    await render(<DialogHarness />);
    await openFromTrigger();
    await click(items()[0]!);
    expect(menu()).toBeNull();
    const field = document.body.querySelector('[data-autofocus]');
    expect(field).not.toBeNull();
    // The surface the action opened holds focus; the menu's restore never steals it back.
    expect(document.activeElement).toBe(field);
  });

  it('a trigger that unmounted while open is skipped without throwing', async () => {
    let hideTrigger!: () => void;
    function UnmountHarness() {
      const [shown, setShown] = useState(true);
      const [open, setOpen] = useState(false);
      hideTrigger = () => { setShown(false); };
      return (
        <>
          {shown ? (
            <button type="button" data-trigger onClick={() => { setOpen(true); }}>
              open menu
            </button>
          ) : null}
          {open ? (
            <MiniContextMenu
              x={10}
              y={10}
              entries={ENTRIES}
              onClose={() => { setOpen(false); }}
              ariaLabel="Test menu"
              overlayId="test-menu"
              dataAttribute="data-test-menu"
            />
          ) : null}
        </>
      );
    }
    await render(<UnmountHarness />);
    await openFromTrigger();
    const gone = trigger();
    await act(async () => { hideTrigger(); });
    expect(document.body.contains(gone)).toBe(false);
    await keydown(window, 'Escape');
    expect(menu()).toBeNull();
    // No focus call onto the detached node and nothing forced onto a stranger.
    expect(document.activeElement).not.toBe(gone);
  });
});

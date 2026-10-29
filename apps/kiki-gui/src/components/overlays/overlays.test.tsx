// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { anyOverlayOpen } from '../../lib/uiBusy';
import { Dialog } from '../Dialog';
import { placeAnchored } from './anchoredPosition';
import { AnchoredPopover, usePopover } from './AnchoredPopover';
import { DetailSplit } from './DetailSplit';
import { usePanelStack } from './PanelStack';
import { useDetailParam } from './useDetailParam';

const VIEWPORT = { width: 1000, height: 700 };
const SURFACE = { width: 300, height: 200 };
const rect = (left: number, top: number, width = 100, height = 32) =>
  ({ left, top, right: left + width, bottom: top + height, width });

describe('placeAnchored', () => {
  it('hangs below the trigger from its start edge when there is room', () => {
    expect(placeAnchored(rect(100, 100), SURFACE, VIEWPORT)).toEqual({ left: 100, top: 138, side: 'below', maxHeight: 554 });
  });

  it('flips above when the bottom has less room than the top', () => {
    const placed = placeAnchored(rect(100, 600), SURFACE, VIEWPORT);
    expect(placed.side).toBe('above');
    expect(placed.top).toBe(600 - 6 - 200);
  });

  it('aligns to the end edge and shifts back inside the viewport', () => {
    expect(placeAnchored(rect(600, 100), SURFACE, VIEWPORT, { align: 'end' }).left).toBe(400);
    expect(placeAnchored(rect(900, 100), SURFACE, VIEWPORT).left).toBe(1000 - 300 - 8);
    expect(placeAnchored(rect(0, 100), SURFACE, VIEWPORT, { align: 'end' }).left).toBe(8);
  });

  it('caps the height to the room there is', () => {
    const placed = placeAnchored(rect(100, 300), { width: 300, height: 900 }, VIEWPORT);
    expect(placed.maxHeight).toBe(700 - 332 - 6 - 8);
  });
});

let container: HTMLDivElement;
let root: Root;
beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => setTimeout(() => run(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { clearTimeout(id); });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
const key = (target: EventTarget, name: string) => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
};

function PopoverHarness() {
  const pop = usePopover();
  return <div>
    <button type="button" data-trigger {...pop.triggerProps}>Per agent</button>
    <button type="button" data-outside>elsewhere</button>
    <AnchoredPopover {...pop.popoverProps} label="Per agent">
      <input data-autofocus data-field aria-label="value" />
    </AnchoredPopover>
  </div>;
}

describe('AnchoredPopover', () => {
  it('wires the trigger, focuses its field, and returns focus on Escape', async () => {
    act(() => { root.render(<PopoverHarness />); });
    const trigger = container.querySelector<HTMLButtonElement>('[data-trigger]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { trigger.focus(); trigger.click(); });
    const surface = document.body.querySelector<HTMLElement>('[data-anchored-popover]')!;
    expect(surface.getAttribute('role')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(surface.id);
    expect(document.activeElement).toBe(surface.querySelector('[data-field]'));
    expect(anyOverlayOpen()).toBe(true);
    await act(async () => { key(document.activeElement!, 'Escape'); });
    expect(document.body.querySelector('[data-anchored-popover]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(anyOverlayOpen()).toBe(false);
  });

  it('closes on an outside press but not on a press inside', async () => {
    act(() => { root.render(<PopoverHarness />); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-trigger]')!.click(); });
    const field = document.body.querySelector<HTMLElement>('[data-field]')!;
    await act(async () => { field.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    expect(document.body.querySelector('[data-anchored-popover]')).not.toBeNull();
    await act(async () => { container.querySelector('[data-outside]')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    expect(document.body.querySelector('[data-anchored-popover]')).toBeNull();
  });

  it('inside a dialog, Escape closes the popover first and the dialog second', async () => {
    const onClose = vi.fn();
    act(() => { root.render(<Dialog onClose={onClose} ariaLabel="Sheet" overlayId="sheet" stacked><PopoverHarness /></Dialog>); });
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-trigger]')!.click(); });
    const surface = document.body.querySelector<HTMLElement>('[data-anchored-popover]')!;
    expect(surface.getAttribute('data-modal-escape')).toBe('sheet');
    await act(async () => { key(surface.querySelector('[data-field]')!, 'Escape'); });
    expect(document.body.querySelector('[data-anchored-popover]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { key(document.activeElement!, 'Escape'); });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

const ITEMS = ['alpha', 'beta'];
let location: ReturnType<typeof useLocation>;
function SplitHarness() {
  const detail = useDetailParam('item');
  location = useLocation();
  return <DetailSplit selected={detail.selected} label="Items"
    list={<ul>{ITEMS.map((item) => <li key={item}><button type="button" data-detail-trigger={item} onClick={() => detail.open(item)}>{item}</button></li>)}</ul>}
    rail={<div data-rail>{ITEMS.map((item) => <button key={item} type="button" data-rail-item={item} onClick={() => detail.open(item)}>{item}</button>)}</div>}
    detail={<div>
      <h3 data-detail-heading tabIndex={-1}>{detail.selected}</h3>
      <button type="button" data-close onClick={detail.close}>Back</button>
    </div>} />;
}

describe('DetailSplit + useDetailParam', () => {
  const mount = (entry = '/settings/items') => {
    act(() => { root.render(<MemoryRouter initialEntries={[entry]}><I18nProvider><SplitHarness /></I18nProvider></MemoryRouter>); });
  };

  it('opens into the URL, keeps the list mounted, moves focus to the heading and back to the row', async () => {
    mount();
    const split = container.querySelector<HTMLElement>('[data-detail-split]')!;
    expect(split.dataset['detailSplit']).toBe('closed');
    const row = container.querySelector<HTMLButtonElement>('[data-detail-trigger="beta"]')!;
    await act(async () => { row.focus(); row.click(); });
    await flush();
    expect(location.search).toBe('?item=beta');
    expect(split.dataset['detailSplit']).toBe('open');
    // No scrim, no modal: the detail is a page section.
    expect(document.body.querySelector('[aria-modal="true"]')).toBeNull();
    expect(container.querySelector<HTMLElement>('[data-detail-list]')!.hidden).toBe(true);
    expect(container.querySelector('[data-detail-trigger="beta"]')).not.toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[data-detail-heading]'));

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-close]')!.click(); });
    await flush();
    expect(location.search).toBe('');
    expect(split.dataset['detailSplit']).toBe('closed');
    expect(document.activeElement).toBe(container.querySelector('[data-detail-trigger="beta"]'));
  });

  it('switches from the rail by replacing, so one Back returns to the list', async () => {
    mount();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-detail-trigger="alpha"]')!.click(); });
    await flush();
    const pushedKey = location.key;
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-rail-item="beta"]')!.click(); });
    await flush();
    expect(location.search).toBe('?item=beta');
    expect(location.key).not.toBe(pushedKey);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-close]')!.click(); });
    await flush();
    expect(location.search).toBe('');
  });

  it('opens straight from a deep link and closes it with a replace', async () => {
    mount('/settings/items?item=alpha&tab=x');
    await flush();
    expect(container.querySelector('[data-detail-heading]')?.textContent).toBe('alpha');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-close]')!.click(); });
    await flush();
    expect(location.search).toBe('?tab=x');
  });
});

describe('usePanelStack', () => {
  it('pushes and pops steps inside one panel', () => {
    let stack: ReturnType<typeof usePanelStack<string>> | undefined;
    function Harness() { stack = usePanelStack('pick'); const [, force] = useState(0); void force; return null; }
    act(() => { root.render(<Harness />); });
    expect(stack!.top).toBe('pick');
    act(() => { stack!.push('form'); });
    expect([stack!.top, stack!.depth]).toEqual(['form', 2]);
    act(() => { stack!.pop(); stack!.pop(); });
    expect([stack!.top, stack!.depth]).toEqual(['pick', 1]);
  });
});

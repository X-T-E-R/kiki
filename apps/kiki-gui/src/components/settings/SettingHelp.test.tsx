// @vitest-environment jsdom

/**
 * The on-demand help control. Four ways in, one way out: hover, keyboard
 * focus, a first touch tap, and Escape. The tap case is the one that regresses
 * quietly — a touch tap focuses the button before the click lands, so a naive
 * toggle closes the bubble the focus handler just opened. Moving the pointer
 * off the `i` toward the bubble must not close it either, or the long text
 * cannot be read.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { SettingHelp } from './SettingHelp';

let container: HTMLDivElement;
let root: Root;
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.setItem('kiki.locale', 'en');
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function render(children = 'How 0 and an empty field are read.'): Promise<HTMLButtonElement> {
  await act(async () => {
    root.render(<I18nProvider><SettingHelp>{children}</SettingHelp></I18nProvider>);
  });
  return container.querySelector<HTMLButtonElement>('[data-setting-help]')!;
}

function bubble(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-setting-help-bubble]');
}

// React derives enter/leave from the mouseover/mouseout pair; a synthetic
// `mouseenter` never reaches the handler. `to` is what the pointer moved from
// or onto. A real crossing of the 6px gap lands on the document body first, so
// `leave` with no `to` is the honest "pointer is in the gap" case, and the
// bubble's own enter is the "pointer reached the text" case.
const over = (node: Element, to: Element | null) => act(async () => {
  node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: to }));
});
const out = (node: Element, to: Element | null) => act(async () => {
  node.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: to }));
});
const enter = (node: Element) => over(node, document.body);
const leave = (node: Element, to: Element | null = null) => out(node, to);

/** Past the close grace, with the timers actually run. */
async function settle(): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(200); });
}

describe('SettingHelp', () => {
  it('opens on hover and closes once the pointer is gone', async () => {
    vi.useFakeTimers();
    const trigger = await render();
    await enter(trigger);
    expect(bubble()?.textContent).toContain('How 0 and an empty field are read.');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await leave(trigger);
    await settle();
    expect(bubble()).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    vi.useRealTimers();
  });

  it('opens on keyboard focus and closes on Escape, returning focus to the trigger', async () => {
    const trigger = await render();
    await act(async () => { trigger.focus(); });
    expect(bubble()).not.toBeNull();
    // The bubble is the trigger's description, so it is announced where the
    // reader already is.
    const id = trigger.getAttribute('aria-describedby');
    expect(id).not.toBeNull();
    expect(document.querySelector(`#${id}`)).toBe(bubble());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(bubble()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on Escape from a pure hover, without stealing focus into the trigger', async () => {
    // A reader who only ever hovered never focused the `i`. Closing must not
    // move focus onto it: `focus` would open the bubble again, and it would
    // also take the keyboard away from wherever the reader actually was.
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    const trigger = await render();
    await act(async () => { elsewhere.focus(); });
    expect(document.activeElement).toBe(elsewhere);
    await enter(trigger);
    expect(bubble()).not.toBeNull();
    // The pointer is still on the `i`; Escape is what puts the bubble away.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(bubble()).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('stays open on the first touch tap, which arrives after focus already opened it', async () => {
    const trigger = await render();
    // A tap is focus-then-click: the focus handler opens, and a plain toggle
    // in `click` would close the same bubble in the same gesture.
    await act(async () => { trigger.focus(); });
    await act(async () => { trigger.click(); });
    expect(bubble()).not.toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    // A second, deliberate tap puts it away.
    await act(async () => { trigger.click(); });
    expect(bubble()).toBeNull();
  });

  it('survives crossing the gap between the trigger and the bubble, so the text is readable', async () => {
    vi.useFakeTimers();
    const trigger = await render('A long explanation that has to stay readable on the way in.');
    await enter(trigger);
    const open = bubble()!;
    // The pointer leaves the `i` into the 6px gap: what it is over first is
    // neither the trigger nor the bubble, and it must not vanish there.
    await leave(trigger, null);
    expect(bubble()).not.toBeNull();
    // Then it reaches the bubble, still inside the grace window.
    await enter(open);
    await settle();
    expect(bubble()).not.toBeNull();
    // Leaving the bubble for good does close it.
    await leave(open);
    await settle();
    expect(bubble()).toBeNull();
    vi.useRealTimers();
  });

  it('keeps a long explanation intact and reachable by assistive tech', async () => {
    const trigger = await render();
    await enter(trigger);
    const open = bubble()!;
    expect(open.getAttribute('role')).toBe('tooltip');
    // Not `pointer-events-none`: the text has to be selectable.
    expect(open.className).not.toContain('pointer-events-none');
    // A trigger always has an accessible name of its own, not just the bubble.
    expect(trigger.getAttribute('aria-label')).toBe('More about this');
  });
});

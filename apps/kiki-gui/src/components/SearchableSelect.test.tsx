// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { SearchableSelect, type SearchableSelectOption } from './SearchableSelect';

const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  // Unmounting is what removes the portal: the panel renders into <body>, not
  // into the container this test drops on the floor, so a root left mounted
  // would still own a live panel when the next test queries the document.
  for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  for (const panel of document.querySelectorAll('[data-select-panel]')) {
    if (panel.isConnected) panel.remove();
  }
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

const OPTIONS: readonly SearchableSelectOption[] = [
  { value: 'a', label: 'Alpha', hint: 'C:/work/alpha' },
  { value: 'b', label: 'Beta', hint: 'C:/work/beta' },
  { value: 'c', label: 'Gamma', hint: 'C:/work/gamma' },
];

/** Renders one select and registers its root for teardown. */
const roots: Root[] = [];

async function renderSelect(
  props: Partial<Parameters<typeof SearchableSelect>[0]> = {},
): Promise<{ container: HTMLDivElement; root: Root; onChange: ReturnType<typeof vi.fn> }> {
  const onChange = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <I18nProvider>
        <SearchableSelect
          id="test-select"
          options={OPTIONS}
          value="b"
          onChange={onChange}
          ariaLabel="Pick one"
          {...props}
        />
      </I18nProvider>,
    );
  });
  return { container, root, onChange };
}

/**
 * The trigger stays inside the render container; the panel does not — it is
 * portaled to <body> so no scrolling or transformed ancestor can clip it. The
 * panel queries therefore start at the document, and the per-test container is
 * still what identifies "this select" when several are mounted.
 */
function trigger(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!;
}

function searchInput(container: HTMLElement): HTMLInputElement {
  return openPanel().querySelector<HTMLInputElement>('input[role="combobox"]')!;
}

/** The one open panel, wherever it is mounted. */
function openPanel(): HTMLElement {
  const panel = document.querySelector<HTMLElement>('[data-select-panel]');
  if (panel === null) throw new Error('no open panel');
  return panel;
}

function options(container: HTMLElement): HTMLElement[] {
  const panel = document.querySelector<HTMLElement>('[data-select-panel]');
  if (panel === null) return [];
  return [...panel.querySelectorAll<HTMLElement>('[role="option"]')];
}

async function typeIn(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(input: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('SearchableSelect', () => {
  it('shows the selected label on the closed trigger, with a full-title tooltip', async () => {
    const { container } = await renderSelect();
    const button = trigger(container);
    expect(button.textContent).toContain('Beta');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-select-panel]')).toBeNull();
  });

  it('opens on click, lists every option, and marks the selected one', async () => {
    const { container } = await renderSelect();
    await act(async () => { trigger(container).click(); });
    expect(trigger(container).getAttribute('aria-expanded')).toBe('true');
    const rows = options(container);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(rows[0]?.textContent).toContain('C:/work/alpha');
  });

  it('filters options by label and hint as the query changes', async () => {
    const { container } = await renderSelect();
    await act(async () => { trigger(container).click(); });
    await typeIn(searchInput(container), 'alp');
    expect(options(container)).toHaveLength(1);
    expect(options(container)[0]?.textContent).toContain('Alpha');
    await typeIn(searchInput(container), 'work/beta');
    expect(options(container)).toHaveLength(1);
    expect(options(container)[0]?.textContent).toContain('Beta');
  });

  it('shows the no-match text when filtering removes every option', async () => {
    const { container } = await renderSelect();
    await act(async () => { trigger(container).click(); });
    await typeIn(searchInput(container), 'zzz');
    expect(options(container)).toHaveLength(0);
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain('No matches for “zzz”.');
  });

  it('shows the empty text when there are no options at all', async () => {
    const { container } = await renderSelect({ options: [], value: '', emptyText: '(no workspaces)' });
    await act(async () => { trigger(container).click(); });
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain('(no workspaces)');
  });

  it('commits the active option with ArrowDown + Enter and closes', async () => {
    const { container, onChange } = await renderSelect();
    await act(async () => { trigger(container).click(); });
    const input = searchInput(container);
    await press(input, 'ArrowDown');
    await press(input, 'Enter');
    expect(onChange).toHaveBeenCalledWith('b');
    expect(document.querySelector('[data-select-panel]')).toBeNull();
  });

  it('wraps around with ArrowUp from the first row', async () => {
    const { container, onChange } = await renderSelect();
    await act(async () => { trigger(container).click(); });
    const input = searchInput(container);
    await press(input, 'ArrowUp');
    expect(input.getAttribute('aria-activedescendant')).toBe('test-select-list-option-2');
    await press(input, 'Enter');
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('commits unmatched search text as a custom value', async () => {
    const { container, onChange } = await renderSelect({
      allowCustomValue: true,
      customValueLabel: (value) => `Use ${value}`,
    });
    await act(async () => { trigger(container).click(); });
    const input = searchInput(container);
    await typeIn(input, 'vendor/model:v2');
    expect(options(container)).toHaveLength(1);
    expect(options(container)[0]?.textContent).toContain('Use vendor/model:v2');
    await press(input, 'Enter');
    expect(onChange).toHaveBeenCalledWith('vendor/model:v2');
    expect(document.querySelector('[data-select-panel]')).toBeNull();
  });

  it('prefers a matching option over the custom row on Enter', async () => {
    const { container, onChange } = await renderSelect({ allowCustomValue: true });
    await act(async () => { trigger(container).click(); });
    const input = searchInput(container);
    await typeIn(input, 'alp');
    expect(options(container)).toHaveLength(2);
    await press(input, 'Enter');
    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('closes on Escape without committing', async () => {
    const { container, onChange } = await renderSelect();
    await act(async () => { trigger(container).click(); });
    await press(searchInput(container), 'Escape');
    expect(document.querySelector('[data-select-panel]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('selects on mouse click and closes', async () => {
    const { container, onChange } = await renderSelect();
    await act(async () => { trigger(container).click(); });
    await act(async () => { options(container)[2]!.click(); });
    expect(onChange).toHaveBeenCalledWith('c');
    expect(document.querySelector('[data-select-panel]')).toBeNull();
  });

  it('closes on an outside pointerdown', async () => {
    const { container } = await renderSelect();
    await act(async () => { trigger(container).click(); });
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(document.querySelector('[data-select-panel]')).toBeNull();
  });
});

/**
 * The container contract. A picker opened inside a scrolling sheet or a
 * scrolling page column used to be laid out in the trigger's own flow, so the
 * sheet clipped it and the panel could run past the viewport edge. These pin
 * the two things that fix depends on: the panel is a <body> child, and a
 * caller that brings its own positioning keeps its panel inline.
 */
describe('SearchableSelect panel container', () => {
  it('portals the panel to the body, outside the trigger root', async () => {
    const { container } = await renderSelect();
    await act(async () => { trigger(container).click(); });
    const panel = document.querySelector<HTMLElement>('[data-select-panel]')!;
    expect(panel.parentElement).toBe(document.body);
    expect(container.contains(panel)).toBe(false);
    // The trigger stays put: the trigger is what owns the open state.
    expect(panel.contains(trigger(container))).toBe(false);
  });

  it('positions the portaled panel against the viewport, not the trigger flow', async () => {
    const { container } = await renderSelect();
    await act(async () => { trigger(container).click(); });
    const panel = document.querySelector<HTMLElement>('[data-select-panel]')!;
    // jsdom applies no Tailwind, so the contract is asserted on the classes
    // the real build resolves: `fixed` plus the flex column that lets the
    // list take the height the placement hook measured.
    expect(panel.className).toContain('fixed');
    expect(panel.className).toContain('flex');
    expect(panel.className).toContain('flex-col');
    expect(panel.className).not.toContain('absolute');
  });

  it('closes on Escape from the portaled panel and returns focus to the trigger', async () => {
    const { container } = await renderSelect();
    const button = trigger(container);
    await act(async () => { button.click(); });
    await act(async () => { button.focus(); });
    // Escape from inside the panel, which is no longer a child of the root: the
    // root's own keydown cannot see this key.
    await press(searchInput(container), 'Escape');
    expect(document.querySelector('[data-select-panel]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('keeps a caller-owned panel inline, so the composer can anchor it itself', async () => {
    const { container } = await renderSelect({
      panelClassName: 'absolute bottom-full left-0 w-96',
      placement: 'above',
    });
    await act(async () => { trigger(container).click(); });
    const panel = document.querySelector<HTMLElement>('[data-select-panel]')!;
    expect(container.contains(panel)).toBe(true);
    expect(panel.className).toBe('absolute bottom-full left-0 w-96');
  });
});


describe('SearchableSelect disabled options', () => {
  it.each(['comfortable', 'compact'] as const)('shows disabled rows but skips clicks and arrow navigation (%s)', async (density) => {
    const { container, onChange } = await renderSelect({ density, options: [
      { value: 'a', label: 'Alpha', disabled: true, hint: 'profile:example.restrict_models_to_menu' },
      { value: 'b', label: 'Beta' },
      { value: 'c', label: 'Gamma', disabled: true },
      { value: 'd', label: 'Delta' },
    ] });
    await act(async () => trigger(container).click());
    const rows = options(container);
    expect(rows[0]!.getAttribute('aria-disabled')).toBe('true');
    expect((rows[0] as HTMLButtonElement).disabled).toBe(true);
    await act(async () => rows[0]!.click());
    expect(onChange).not.toHaveBeenCalled();
    const input = searchInput(container);
    expect(input.getAttribute('aria-activedescendant')).toBe('test-select-list-option-1');
    await press(input, 'ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe('test-select-list-option-3');
    await press(input, 'ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe('test-select-list-option-1');
    await press(input, 'ArrowUp');
    expect(input.getAttribute('aria-activedescendant')).toBe('test-select-list-option-3');
    await press(input, 'Enter');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('d');
  });
  it('does not commit when filtering leaves only disabled rows', async () => {
    const { container, onChange } = await renderSelect({ options: [{ value: 'a', label: 'Alpha', disabled: true }, { value: 'b', label: 'Beta' }] });
    await act(async () => trigger(container).click());
    await typeIn(searchInput(container), 'Alpha');
    const input = searchInput(container);
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    await press(input, 'ArrowDown');
    await press(input, 'Enter');
    expect(onChange).not.toHaveBeenCalled();
    expect(document.querySelector('[data-select-panel]')).not.toBeNull();
  });
});

/**
 * Which side the portaled panel opens into. The preference is a tie-breaker,
 * not an override: a side with more room always wins, and a trigger with almost
 * no space on either side must not be handed a minimum height it does not have
 * (that pushes the panel past the viewport edge).
 *
 * Room is measured the way the component measures it: `PANEL_GAP` (4) plus
 * `VIEWPORT_MARGIN` (8) come off the far edge of the trigger.
 */
const roomAbove = (top: number) => top - 4 - 8;
const roomBelow = (top: number, height: number) => height - (top + 32) - 4 - 8;

/** Opens one picker with its trigger pinned at `top` in a `height` viewport. */
async function placeAt(top: number, height: number, placement?: 'above' | 'below'): Promise<CSSStyleDeclaration> {
  (window as unknown as { innerHeight: number }).innerHeight = height;
  const onChange = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <I18nProvider>
        <SearchableSelect id="place-probe" value="a" ariaLabel="Pick" placement={placement}
          options={OPTIONS} onChange={onChange} />
      </I18nProvider>,
    );
  });
  const trigger = container.querySelector<HTMLButtonElement>('#place-probe')!;
  trigger.getBoundingClientRect = () => ({
    left: 40, right: 200, top, bottom: top + 32, width: 160, height: 32, x: 40, y: top,
    toJSON: () => ({}),
  } as DOMRect);
  await act(async () => { trigger.click(); });
  return openPanel().style;
}

const openedAbove = (style: CSSStyleDeclaration) => style.bottom !== '' && style.top === '';

describe('SearchableSelect panel side', () => {
  it('opens above when above has the room, even with the preference above', async () => {
    // 688px above, 56px below: below is not merely smaller, it is unusable.
    expect({ above: roomAbove(700), below: roomBelow(700, 800) }).toEqual({ above: 688, below: 56 });
    const style = await placeAt(700, 800, 'above');
    expect(openedAbove(style)).toBe(true);
    expect(style.top).toBe('');
    expect(Number.parseFloat(style.maxHeight)).toBeLessThanOrEqual(roomAbove(700));
  });

  it('keeps the preferred side when both sides have the same room', async () => {
    // Equal room: above = t - 12, below = h - (t + 32) - 12; equal at t = (h-32)/2.
    const height = 800, top = (height - 32) / 2;
    expect(roomAbove(top)).toBe(roomBelow(top, height));
    const style = await placeAt(top, height, 'above');
    expect(openedAbove(style)).toBe(true);
  });

  it('is never taller than the room it opens into', async () => {
    // A short viewport: below is the roomier side and holds only 96px, so a
    // minimum height would push the panel past the viewport edge.
    const height = 180, top = 40;
    expect(roomBelow(top, height)).toBe(96);
    const style = await placeAt(top, height);
    expect(openedAbove(style)).toBe(false);
    const declared = Number.parseFloat(style.maxHeight);
    expect(declared).toBeGreaterThan(0);
    expect(declared).toBeLessThanOrEqual(roomBelow(top, height));
  });

  it('still prefers below by default when below is the roomier side', async () => {
    const height = 800, top = 60;
    const style = await placeAt(top, height);
    expect(openedAbove(style)).toBe(false);
    expect(Number.parseFloat(style.maxHeight)).toBeLessThanOrEqual(roomBelow(top, height));
  });
});

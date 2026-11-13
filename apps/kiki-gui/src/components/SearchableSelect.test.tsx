// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { PHONE_QUERY } from '../lib/layoutHooks';
import { MODAL_BASE_Z_INDEX } from '../lib/uiBusy';
import { Dialog } from './Dialog';
import {
  SearchableSelect,
  type SearchableMultiSelectProps,
  type SearchableSelectOption,
  type SearchableSingleSelectProps,
} from './SearchableSelect';
import { SettingsSelect } from './settings/SettingsPrimitives';

const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  for (const panel of document.querySelectorAll('[data-select-panel], [data-select-sheet]')) {
    if (panel.isConnected) panel.remove();
  }
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

const SHORT_OPTIONS: readonly SearchableSelectOption[] = [
  { value: 'a', label: 'Alpha', hint: 'C:/work/alpha' },
  { value: 'b', label: 'Beta', hint: 'C:/work/beta' },
  { value: 'c', label: 'Gamma', hint: 'C:/work/gamma' },
];

const EIGHT_OPTIONS: readonly SearchableSelectOption[] = [
  { value: 'a', label: 'Alpha', hint: 'C:/work/alpha' },
  { value: 'b', label: 'Beta', hint: 'C:/work/beta' },
  { value: 'c', label: 'Gamma', hint: 'C:/work/gamma' },
  { value: 'd', label: 'Delta', hint: 'C:/work/delta' },
  { value: 'e', label: 'Epsilon', hint: 'C:/work/epsilon' },
  { value: 'f', label: 'Zeta', hint: 'C:/work/zeta' },
  { value: 'g', label: 'Eta', hint: 'C:/work/eta' },
  { value: 'h', label: 'Theta', hint: 'C:/work/theta' },
];

/** Renders one select and registers its root for teardown. */
const roots: Root[] = [];

async function renderSelect(
  props: Partial<SearchableSingleSelectProps> = {},
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
          options={EIGHT_OPTIONS}
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

function trigger(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!;
}

function searchInput(_container: HTMLElement): HTMLInputElement {
  return openPanel().querySelector<HTMLInputElement>('input[role="combobox"]')!;
}

/** The one open panel, wherever it is mounted. */
function openPanel(): HTMLElement {
  const panel = document.querySelector<HTMLElement>('[data-select-panel]');
  if (panel === null) throw new Error('no open panel');
  return panel;
}

function options(_container: HTMLElement): HTMLElement[] {
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
    const { container } = await renderSelect({ options: SHORT_OPTIONS });
    await act(async () => { trigger(container).click(); });
    expect(trigger(container).getAttribute('aria-expanded')).toBe('true');
    const rows = options(container);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(rows[0]?.textContent).toContain('C:/work/alpha');
  });

  it('hides the search field below 8 options and shows it at 8 or more (LIST_TOOLS_MIN_ITEMS)', async () => {
    const seven = EIGHT_OPTIONS.slice(0, 7);
    const { container: shortContainer } = await renderSelect({ id: 'short', options: seven });
    await act(async () => { trigger(shortContainer).click(); });
    expect(openPanel().querySelector('input[role="combobox"]')).toBeNull();
    await act(async () => { trigger(shortContainer).click(); });

    const { container: longContainer } = await renderSelect({ id: 'long', options: EIGHT_OPTIONS });
    await act(async () => { trigger(longContainer).click(); });
    expect(openPanel().querySelector('input[role="combobox"]')).not.toBeNull();
    await act(async () => { trigger(longContainer).click(); });

    // hideFilter overrides in both directions
    const { container: forcedHidden } = await renderSelect({ id: 'forced-hidden', options: EIGHT_OPTIONS, hideFilter: true });
    await act(async () => { trigger(forcedHidden).click(); });
    expect(openPanel().querySelector('input[role="combobox"]')).toBeNull();
    await act(async () => { trigger(forcedHidden).click(); });

    const { container: forcedShown } = await renderSelect({ id: 'forced-shown', options: SHORT_OPTIONS, hideFilter: false });
    await act(async () => { trigger(forcedShown).click(); });
    expect(openPanel().querySelector('input[role="combobox"]')).not.toBeNull();
  });

  it('supports keyboard navigation on short lists without a search input', async () => {
    const { container, onChange } = await renderSelect({ options: SHORT_OPTIONS });
    await act(async () => { trigger(container).click(); });
    const listbox = openPanel().querySelector<HTMLElement>('[role="listbox"]')!;
    expect(document.activeElement).toBe(listbox);
    await press(listbox, 'ArrowDown');
    await press(listbox, 'Enter');
    expect(onChange).toHaveBeenCalledWith('b');
    expect(document.querySelector('[data-select-panel]')).toBeNull();
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
    const { container, onChange } = await renderSelect({ options: SHORT_OPTIONS, hideFilter: false });
    await act(async () => { trigger(container).click(); });
    const input = searchInput(container);
    await press(input, 'ArrowUp');
    expect(input.getAttribute('aria-activedescendant')).toBe('test-select-list-option-2');
    await press(input, 'Enter');
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('commits unmatched search text as a custom value', async () => {
    const { container, onChange } = await renderSelect({
      options: SHORT_OPTIONS,
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
    const { container, onChange } = await renderSelect({ options: SHORT_OPTIONS, allowCustomValue: true });
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
    const { container, onChange } = await renderSelect({ options: SHORT_OPTIONS });
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

describe('SearchableSelect multiple mode', () => {
  function StatefulMulti({
    initialValues = ['a'],
    onChange,
    allowCustomValue,
  }: {
    initialValues?: readonly string[];
    onChange?: (next: string[]) => void;
    allowCustomValue?: boolean;
  }) {
    const [values, setValues] = useState<readonly string[]>(initialValues);
    return (
      <I18nProvider>
        <SearchableSelect
          multiple
          id="multi-select"
          options={EIGHT_OPTIONS}
          values={values}
          allowCustomValue={allowCustomValue}
          onChange={(next) => {
            setValues(next);
            onChange?.(next);
          }}
          emptyText="All models"
          ariaLabel="Pick models"
        />
      </I18nProvider>
    );
  }

  it('toggles multiple rows without closing, updates trigger summary, and closes on Escape', async () => {
    const onChange = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => { root.render(<StatefulMulti onChange={onChange} />); });

    const btn = trigger(container);
    expect(btn.textContent).toContain('Alpha');
    await act(async () => { btn.click(); });
    expect(openPanel().querySelector('[role="listbox"]')?.getAttribute('aria-multiselectable')).toBe('true');

    // Click Beta: stays open, adds 'b'
    await act(async () => { options(container)[1]!.click(); });
    expect(onChange).toHaveBeenLastCalledWith(['a', 'b']);
    expect(document.querySelector('[data-select-panel]')).not.toBeNull();
    expect(btn.textContent).toContain('Alpha +1');

    // Enter on active row (Alpha at index 0) unchecks 'a' without closing
    const input = searchInput(container);
    await press(input, 'Enter');
    expect(onChange).toHaveBeenLastCalledWith(['b']);
    expect(btn.textContent).toContain('Beta');

    // Uncheck Beta -> emptyText
    await act(async () => { options(container)[1]!.click(); });
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(btn.textContent).toContain('All models');

    // Custom value in multiple mode adds without closing
    await act(async () => { root.render(<StatefulMulti key="custom" initialValues={['a']} allowCustomValue onChange={onChange} />); });
    await act(async () => { trigger(container).click(); });
    const customInput = searchInput(container);
    await typeIn(customInput, 'custom/model');
    await press(customInput, 'Enter');
    expect(onChange).toHaveBeenLastCalledWith(['a', 'custom/model']);
    expect(document.querySelector('[data-select-panel]')).not.toBeNull();

    // Escape closes
    await press(customInput, 'Escape');
    expect(document.querySelector('[data-select-panel]')).toBeNull();
  });
});

describe('SearchableSelect phone bottom sheet', () => {
  it('opens as a bottom sheet in phone mode and closes on scrim tap, Escape, and layer-history back', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === PHONE_QUERY || query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    try {
      const settleHistory = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
      window.history.pushState({ route: 'test' }, '');
      const { container } = await renderSelect({ options: SHORT_OPTIONS });
      await act(async () => { trigger(container).click(); });
      const sheet = document.querySelector<HTMLElement>('[data-select-sheet]');
      expect(sheet).not.toBeNull();
      expect(openPanel().className).toContain('kiki-action-sheet');

      // Close on scrim tap
      await act(async () => { document.querySelector<HTMLElement>('[data-select-scrim]')!.click(); });
      await settleHistory();
      expect(document.querySelector('[data-select-sheet]')).toBeNull();

      // Reopen and close on Escape
      await act(async () => { trigger(container).click(); });
      expect(document.querySelector('[data-select-sheet]')).not.toBeNull();
      await press(openPanel(), 'Escape');
      await settleHistory();
      expect(document.querySelector('[data-select-sheet]')).toBeNull();

      // Reopen and close via browser back (layerHistory back gesture)
      await act(async () => { trigger(container).click(); });
      expect(document.querySelector('[data-select-sheet]')).not.toBeNull();
      await act(async () => { window.history.back(); });
      await settleHistory();
      expect(document.querySelector('[data-select-sheet]')).toBeNull();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});

describe('SearchableSelect panel container', () => {
  it('portals the panel to the body, outside the trigger root', async () => {
    const { container } = await renderSelect();
    await act(async () => { trigger(container).click(); });
    const panel = document.querySelector<HTMLElement>('[data-select-panel]')!;
    expect(panel.parentElement).toBe(document.body);
    expect(container.contains(panel)).toBe(false);
    expect(panel.contains(trigger(container))).toBe(false);
  });

  it('positions the portaled panel against the viewport, not the trigger flow', async () => {
    const { container } = await renderSelect();
    await act(async () => { trigger(container).click(); });
    const panel = document.querySelector<HTMLElement>('[data-select-panel]')!;
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
    const { container, onChange } = await renderSelect({
      density,
      hideFilter: false,
      options: [
        { value: 'a', label: 'Alpha', disabled: true, hint: 'profile:example.restrict_models_to_menu' },
        { value: 'b', label: 'Beta' },
        { value: 'c', label: 'Gamma', disabled: true },
        { value: 'd', label: 'Delta' },
      ],
    });
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
    const { container, onChange } = await renderSelect({
      hideFilter: false,
      options: [{ value: 'a', label: 'Alpha', disabled: true }, { value: 'b', label: 'Beta' }],
    });
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

describe('SearchableSelect inside a dialog', () => {
  it('paints above the dialog it was opened from', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <I18nProvider>
          <Dialog
            onClose={() => undefined}
            ariaLabel="Test dialog"
            overlayId="test-dialog"
            stacked
            overlayData={{ 'data-test-dialog-overlay': 'true' }}
            panelClassName="relative h-40 bg-panel"
          >
            <SearchableSelect
              id="in-dialog"
              options={SHORT_OPTIONS}
              value="a"
              onChange={vi.fn()}
              ariaLabel="Pick one"
            />
          </Dialog>
        </I18nProvider>,
      );
    });

    const inDialog = container.ownerDocument.querySelector<HTMLButtonElement>(
      '[data-test-dialog-overlay] [aria-haspopup="listbox"]',
    );
    expect(inDialog).not.toBeNull();
    await act(async () => { inDialog!.click(); });

    const panel = document.querySelector<HTMLElement>('[data-select-panel]');
    const overlay = document.querySelector<HTMLElement>('[data-test-dialog-overlay]');
    expect(panel).not.toBeNull();
    expect(overlay).not.toBeNull();
    const overlayZ = Number.parseFloat(overlay!.style.zIndex);
    const panelZ = Number.parseFloat(panel!.style.zIndex);
    expect(Number.isNaN(overlayZ)).toBe(false);
    expect(panelZ).toBeGreaterThan(overlayZ);
  });

  it('leaves a picker on the plain page at the shared page-level z-index', async () => {
    const { container } = await renderSelect();
    await act(async () => { trigger(container).click(); });
    const panel = document.querySelector<HTMLElement>('[data-select-panel]');
    expect(panel).not.toBeNull();
    expect(Number.parseFloat(panel!.style.zIndex)).toBe(MODAL_BASE_Z_INDEX);
  });
});

const roomAbove = (top: number) => top - 4 - 8;
const roomBelow = (top: number, height: number) => height - (top + 32) - 4 - 8;

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
          options={SHORT_OPTIONS} onChange={onChange} />
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
    expect({ above: roomAbove(700), below: roomBelow(700, 800) }).toEqual({ above: 688, below: 56 });
    const style = await placeAt(700, 800, 'above');
    expect(openedAbove(style)).toBe(true);
    expect(style.top).toBe('');
    expect(Number.parseFloat(style.maxHeight)).toBeLessThanOrEqual(roomAbove(700));
  });

  it('keeps the preferred side when both sides have the same room', async () => {
    const height = 800, top = (height - 32) / 2;
    expect(roomAbove(top)).toBe(roomBelow(top, height));
    const style = await placeAt(top, height, 'above');
    expect(openedAbove(style)).toBe(true);
  });

  it('is never taller than the room it opens into', async () => {
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

describe('SettingsSelect shared SearchableSelect wrapper', () => {
  it('omits search below 8 choices, shows search at >= 8 choices, and opens a bottom sheet on phones', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const onChange = vi.fn();

    await act(async () => {
      root.render(
        <I18nProvider>
          <SettingsSelect id="short-settings-select" ariaLabel="Short" value="a" choices={SHORT_OPTIONS} onChange={onChange} />
        </I18nProvider>,
      );
    });
    await act(async () => { container.querySelector<HTMLButtonElement>('#short-settings-select')!.click(); });
    expect(openPanel().querySelector('input[role="combobox"]')).toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('#short-settings-select')!.click(); });

    await act(async () => {
      root.render(
        <I18nProvider>
          <SettingsSelect id="long-settings-select" ariaLabel="Long" value="a" choices={EIGHT_OPTIONS} onChange={onChange} />
        </I18nProvider>,
      );
    });
    await act(async () => { container.querySelector<HTMLButtonElement>('#long-settings-select')!.click(); });
    expect(openPanel().querySelector('input[role="combobox"]')).not.toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('#long-settings-select')!.click(); });

    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === PHONE_QUERY || query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    try {
      const phoneContainer = document.createElement('div');
      document.body.append(phoneContainer);
      containers.push(phoneContainer);
      const phoneRoot = createRoot(phoneContainer);
      roots.push(phoneRoot);
      await act(async () => {
        phoneRoot.render(
          <I18nProvider>
            <SettingsSelect id="phone-settings-select" ariaLabel="Phone" value="a" choices={SHORT_OPTIONS} onChange={onChange} />
          </I18nProvider>,
        );
      });
      await act(async () => { phoneContainer.querySelector<HTMLButtonElement>('#phone-settings-select')!.click(); });
      expect(document.querySelector('[data-select-sheet]')).not.toBeNull();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});

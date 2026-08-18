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

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
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

async function renderSelect(
  props: Partial<Parameters<typeof SearchableSelect>[0]> = {},
): Promise<{ container: HTMLDivElement; root: Root; onChange: ReturnType<typeof vi.fn> }> {
  const onChange = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
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

function trigger(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!;
}

function searchInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
}

function options(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="option"]')];
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
    expect(container.querySelector('[role="listbox"]')).toBeNull();
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
    expect(container.querySelector('[role="listbox"]')?.textContent).toContain('No matches for “zzz”.');
  });

  it('shows the empty text when there are no options at all', async () => {
    const { container } = await renderSelect({ options: [], value: '', emptyText: '(no workspaces)' });
    await act(async () => { trigger(container).click(); });
    expect(container.querySelector('[role="listbox"]')?.textContent).toContain('(no workspaces)');
  });

  it('commits the active option with ArrowDown + Enter and closes', async () => {
    const { container, onChange } = await renderSelect();
    await act(async () => { trigger(container).click(); });
    const input = searchInput(container);
    await press(input, 'ArrowDown');
    await press(input, 'Enter');
    expect(onChange).toHaveBeenCalledWith('b');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
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

  it('closes on Escape without committing', async () => {
    const { container, onChange } = await renderSelect();
    await act(async () => { trigger(container).click(); });
    await press(searchInput(container), 'Escape');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('selects on mouse click and closes', async () => {
    const { container, onChange } = await renderSelect();
    await act(async () => { trigger(container).click(); });
    await act(async () => { options(container)[2]!.click(); });
    expect(onChange).toHaveBeenCalledWith('c');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('closes on an outside pointerdown', async () => {
    const { container } = await renderSelect();
    await act(async () => { trigger(container).click(); });
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });
});

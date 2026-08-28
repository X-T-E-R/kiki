// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { SessionActionsMenu, SessionTitle } from './SessionView';

vi.mock('./TerminalPanel', () => ({ TerminalPanel: () => null }));

const mounted: { container: HTMLDivElement; root: Root }[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'en');
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => { entry.root.unmount(); });
    entry.container.remove();
  }
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

function mount(node: React.ReactNode): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  act(() => {
    root.render(<I18nProvider>{node}</I18nProvider>);
  });
  return container;
}

function click(element: Element | null): void {
  expect(element).not.toBeNull();
  act(() => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function setValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(input: HTMLElement, name: string): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
}

function actionsMenu(overrides: Partial<React.ComponentProps<typeof SessionActionsMenu>> = {}) {
  const props: React.ComponentProps<typeof SessionActionsMenu> = {
    terminalAvailable: true,
    terminalOpen: false,
    onToggleTerminal: vi.fn(),
    onBeginRename: vi.fn(),
    onAction: vi.fn(),
    ...overrides,
  };
  return { props, container: mount(<SessionActionsMenu {...props} />) };
}

describe('session header overflow menu', () => {
  it('carries rename, terminal and the four session actions', () => {
    const { container } = actionsMenu();
    click(container.querySelector('button[aria-haspopup="menu"]'));
    const labels = [...container.querySelectorAll('[role^="menuitem"]')].map((item) =>
      (item.textContent ?? '').trim(),
    );
    expect(labels).toEqual([
      'Rename…',
      'TerminalCtrl+`',
      'Fork session',
      'Export archive…',
      'Compact context',
      'Undo last turn…',
    ]);
  });

  it('drops the terminal item when the server has no terminal capability', () => {
    const { container } = actionsMenu({ terminalAvailable: false });
    click(container.querySelector('button[aria-haspopup="menu"]'));
    expect(container.querySelector('[data-terminal-toggle]')).toBeNull();
    expect(container.querySelectorAll('[role^="menuitem"]')).toHaveLength(5);
  });

  it('reflects the panel state on the terminal item and toggles it', () => {
    const { props, container } = actionsMenu({ terminalOpen: true });
    click(container.querySelector('button[aria-haspopup="menu"]'));
    const item = container.querySelector('[data-terminal-toggle]');
    expect(item?.getAttribute('aria-checked')).toBe('true');
    click(item);
    expect(props.onToggleTerminal).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-terminal-toggle]')).toBeNull();
  });

  it('hands rename back to the header and closes', () => {
    const { props, container } = actionsMenu();
    click(container.querySelector('button[aria-haspopup="menu"]'));
    click(container.querySelector('[data-session-rename]'));
    expect(props.onBeginRename).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-session-rename]')).toBeNull();
  });

  it('keeps the trigger textless — it is an icon button', () => {
    const { container } = actionsMenu();
    const trigger = container.querySelector('button[aria-haspopup="menu"]');
    expect(trigger?.textContent).toBe('');
    expect(trigger?.getAttribute('aria-label')).toBe('Session actions');
  });
});

describe('session title', () => {
  function title(overrides: Partial<React.ComponentProps<typeof SessionTitle>> = {}) {
    const onEditingChange = vi.fn();
    const onRename = vi.fn(async () => {});
    const onOpenRail = vi.fn();
    const props: React.ComponentProps<typeof SessionTitle> = {
      title: 'Release prep',
      cwd: 'C:/fixture/workshop',
      editing: false,
      onEditingChange,
      onRename,
      onOpenRail,
      ...overrides,
    };
    return { props, container: mount(<SessionTitle {...props} />) };
  }

  it('shows the shortened cwd and opens the rail when it is clicked', () => {
    const { props, container } = title();
    const cwd = container.querySelector('[data-session-cwd]');
    expect(cwd?.textContent).toBe('…/fixture/workshop');
    click(cwd);
    expect(props.onOpenRail).toHaveBeenCalledTimes(1);
  });

  it('enters edit mode when the title is clicked', () => {
    const { props, container } = title();
    click(container.querySelector('[data-session-title]'));
    expect(props.onEditingChange).toHaveBeenCalledWith(true);
  });

  it('commits a new title on Enter', () => {
    const { props, container } = title({ editing: true });
    const input = container.querySelector<HTMLInputElement>('[data-session-rename-input]')!;
    setValue(input, 'Ship the batch');
    key(input, 'Enter');
    expect(props.onRename).toHaveBeenCalledWith('Ship the batch');
    expect(props.onEditingChange).toHaveBeenCalledWith(false);
  });

  it('reverts on Escape without renaming', () => {
    const { props, container } = title({ editing: true });
    const input = container.querySelector<HTMLInputElement>('[data-session-rename-input]')!;
    setValue(input, 'Discarded');
    key(input, 'Escape');
    expect(props.onRename).not.toHaveBeenCalled();
    expect(props.onEditingChange).toHaveBeenCalledWith(false);
  });

  it('commits on blur, and only once', () => {
    const { props, container } = title({ editing: true });
    const input = container.querySelector<HTMLInputElement>('[data-session-rename-input]')!;
    setValue(input, 'Ship the batch');
    // React maps onBlur off the bubbling focusout event.
    act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(props.onRename).toHaveBeenCalledTimes(1);
  });

  it('sends no patch for an unchanged or empty title', () => {
    const first = title({ editing: true });
    key(first.container.querySelector('[data-session-rename-input]')!, 'Enter');
    expect(first.props.onRename).not.toHaveBeenCalled();

    const second = title({ editing: true });
    const input = second.container.querySelector<HTMLInputElement>('[data-session-rename-input]')!;
    setValue(input, '   ');
    key(input, 'Enter');
    expect(second.props.onRename).not.toHaveBeenCalled();
  });

  it('hides the cwd while renaming so the input owns the row', () => {
    const { container } = title({ editing: true });
    expect(container.querySelector('[data-session-cwd]')).toBeNull();
  });
});

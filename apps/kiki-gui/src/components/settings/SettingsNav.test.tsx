// @vitest-environment jsdom

/**
 * Grouped settings navigation (redesign batch 1): visual group headers,
 * breadcrumb search hits, and the unknown-section notice with search guidance.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { SettingsNav } from './SettingsNav';
import { UnknownSettingsSection } from './UnknownSection';

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<I18nProvider>{node}</I18nProvider>);
  });
  return container;
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const noop = () => {};

describe('SettingsNav grouped tree', () => {
  it('renders four non-clickable groups and keeps every leaf reachable', async () => {
    const container = await render(
      <SettingsNav active="ai" searchFocusToken={null} onNavigate={noop} onSearchHit={noop} />,
    );
    const groups = [...container.querySelectorAll('[data-settings-nav-group]')];
    expect(groups.map((group) => group.getAttribute('data-settings-nav-group')))
      .toEqual(['app', 'models-agents', 'tools-integrations', 'system-data']);
    expect([...groups[0]!.querySelectorAll('[data-settings-nav-leaf]')].map((leaf) => leaf.getAttribute('data-settings-nav-leaf')))
      .toEqual(['general', 'appearance', 'connection']);
    expect(groups.map((group) => group.querySelector('p')?.textContent))
      .toEqual(['Your app', 'Models & agents', 'Tools & integrations', 'System & data']);
    for (const group of groups) expect(group.querySelector(':scope > button')).toBeNull();
    expect([...groups[1]!.querySelectorAll('[data-settings-nav-leaf]')].map((leaf) => leaf.getAttribute('data-settings-nav-leaf')))
      .toEqual(['ai', 'agents', 'subagents', 'communication', 'tasks']);
    expect([...groups[2]!.querySelectorAll('[data-settings-nav-leaf]')].map((leaf) => leaf.getAttribute('data-settings-nav-leaf')))
      .toEqual(['skills', 'mcp', 'plugins', 'automation', 'search']);
    expect([...groups[3]!.querySelectorAll('[data-settings-nav-leaf]')].map((leaf) => leaf.getAttribute('data-settings-nav-leaf')))
      .toEqual(['workspaces', 'advanced', 'about']);
    expect(container.querySelector('[data-settings-nav-ungrouped]')).toBeNull();
  });

  it('highlights only the active leaf and navigates on click', async () => {
    const visited: string[] = [];
    const container = await render(
      <SettingsNav active="skills" searchFocusToken={null} onNavigate={(id) => { visited.push(id); }} onSearchHit={noop} />,
    );
    const active = [...container.querySelectorAll('[aria-current="page"]')];
    expect(active.map((button) => button.textContent)).toEqual(['Skills']);
    // Selection is a raised sheet, never an accent fill.
    expect(active[0]!.className).toContain('shadow-[var(--kiki-sheet-shadow)]');
    expect(container.querySelector('nav')!.innerHTML).not.toContain('accent');
    const models = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Models & providers')!;
    await click(models);
    expect(visited).toEqual(['ai']);
  });

  it('shows group › section › card breadcrumbs in search hits', async () => {
    const container = await render(
      <SettingsNav active="general" searchFocusToken={null} onNavigate={noop} onSearchHit={noop} />,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await typeInto(input, 'appearance');
    const hits = [...container.querySelectorAll('[role="option"]')];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.textContent).toBe('Theme & colorYour app › Appearance');
  });

  it('finds cards by legacy synonym and reports the hit', async () => {
    const hits: string[] = [];
    const container = await render(
      <SettingsNav active="general" searchFocusToken={null} onNavigate={noop} onSearchHit={(entry) => { hits.push(entry.cardId); }} />,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await typeInto(input, '供应商');
    const option = [...container.querySelectorAll('[role="option"]')]
      .find((element) => element.textContent!.toLowerCase().includes('providers'))!;
    await click(option);
    expect(hits.length).toBe(1);
  });

  it('renders subtabs under Search & retrieval when active="search" and navigates on subtab click', async () => {
    const visited: string[] = [];
    const container = await render(
      <SettingsNav active="search" searchFocusToken={null} onNavigate={(id) => { visited.push(id); }} onSearchHit={noop} />,
    );
    const subtabsContainer = container.querySelector('[data-settings-nav-subtabs="search"]');
    expect(subtabsContainer).not.toBeNull();
    const subtabButtons = [...subtabsContainer!.querySelectorAll('button')];
    expect(subtabButtons.map((b) => b.textContent)).toEqual([
      'Overview & source',
      'Search lanes',
      'Fetch chain',
      'Services & credentials',
      'Advanced & diagnostics',
    ]);

    await click(subtabButtons[2]!);
    expect(visited).toEqual(['search?tab=fetch']);
  });
});

describe('UnknownSettingsSection', () => {
  it('names the missing section and offers search instead of a silent fallback', async () => {
    const hits: string[] = [];
    const container = await render(
      <UnknownSettingsSection section="retired-page" onSearchHit={(entry) => { hits.push(entry.section); }} />,
    );
    expect(container.textContent).toContain('This setting does not exist');
    expect(container.textContent).toContain('retired-page');
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await typeInto(input, 'mcp');
    const option = container.querySelector('[role="option"]')!;
    await click(option);
    expect(hits).toEqual(['mcp']);
  });
});

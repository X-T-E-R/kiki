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
  it('draws one continuous list of intent groups, every leaf reachable', async () => {
    const container = await render(
      <SettingsNav active="ai" searchFocusToken={null} onNavigate={noop} onSearchHit={noop} />,
    );
    // No scope blocks above the groups, and no rule splitting them.
    expect(container.querySelector('[data-settings-nav-storage]')).toBeNull();
    const tree = container.querySelector('[data-settings-nav-tree]')!;
    expect([...tree.children].every((child) => child.hasAttribute('data-settings-nav-group'))).toBe(true);
    expect(tree.querySelector('.border-t')).toBeNull();
    expect(container.textContent).not.toMatch(/This device|All sessions|127\.0\.0\.1/);
    const groups = [...container.querySelectorAll('[data-settings-nav-group]')];
    expect(groups.map((group) => group.getAttribute('data-settings-nav-group')))
      .toEqual(['device', 'connection', 'models-agents', 'work', 'capabilities', 'workspace', 'advanced']);
    expect(groups.map((group) => group.querySelector('p')?.textContent))
      .toEqual(['App', 'Connection & remote', 'Models & agents', 'How work runs', 'Capabilities', 'Workspaces', 'Advanced']);
    for (const group of groups) expect(group.querySelector(':scope > button')).toBeNull();
    const leaves = (index: number) => [...groups[index]!.querySelectorAll('[data-settings-nav-leaf]')].map((leaf) => leaf.getAttribute('data-settings-nav-leaf'));
    expect(leaves(0)).toEqual(['general', 'appearance', 'shortcuts']);
    expect(leaves(1)).toEqual(['connection', 'ssh']);
    expect(leaves(2)).toEqual(['ai', 'identity', 'agents', 'subagents']);
    expect(leaves(3)).toEqual(['sessions', 'notifications', 'memory', 'permissions', 'tasks']);
    expect(leaves(4)).toEqual(['skills', 'mcp', 'plugins', 'search', 'hooks']);
    expect(leaves(5)).toEqual(['workspaces', 'spaces']);
    expect(leaves(6)).toEqual(['developer', 'labs', 'about']);
  });

  it('highlights only the active leaf and navigates on click', async () => {
    const visited: string[] = [];
    const container = await render(
      <SettingsNav active="skills" searchFocusToken={null} onNavigate={(id) => { visited.push(id); }} onSearchHit={noop} />,
    );
    const active = [...container.querySelectorAll('[aria-current="page"]')];
    expect(active.map((button) => button.textContent)).toEqual(['Skills']);
    // Selection is the shared row rule (a paper sheet + inset mark from
    // .row-interactive[aria-current]), not an accent fill.
    expect(active[0]!.classList.contains('row-interactive')).toBe(true);
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
    // The group › section separator is the drawn chevron, not a typed glyph.
    expect(hits[0]!.textContent).toBe('Theme & colorAppAppearance');
    expect(hits[0]!.querySelector('[data-icon="chevron"]')).not.toBeNull();
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
    await typeInto(input, 'mcp server');
    const option = container.querySelector('[role="option"]')!;
    await click(option);
    expect(hits).toEqual(['mcp']);
  });
});

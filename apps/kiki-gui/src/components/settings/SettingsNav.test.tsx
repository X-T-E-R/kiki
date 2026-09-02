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
  it('renders non-clickable group headers and keeps About as an ungrouped leaf', async () => {
    const container = await render(
      <SettingsNav active="ai" searchFocusToken={null} onNavigate={noop} onSearchHit={noop} />,
    );
    const groups = [...container.querySelectorAll('[data-settings-nav-group]')];
    // Batch 3 filled "Data & advanced": all six groups render now.
    expect(groups.map((group) => group.getAttribute('data-settings-nav-group')))
      .toEqual(['app', 'ai', 'agents', 'extensions', 'system', 'advanced']);
    for (const group of groups) {
      const header = group.querySelector('p');
      expect(header).not.toBeNull();
      expect(group.querySelector(':scope > button')).toBeNull();
    }
    const aiGroup = groups[1]!;
    expect(aiGroup.querySelector('p')!.textContent).toBe('AI configuration');
    // Batch 2 merged the two AI leaves into the single "Models & providers"
    // entry; its tabs live inside the page, not in the nav tree.
    const leaves = [...aiGroup.querySelectorAll('button')].map((button) => button.textContent);
    expect(leaves).toEqual(['Models & providers']);
    // The extensions group carries the batch-3 split leaves in order.
    const extensionsGroup = groups[3]!;
    expect([...extensionsGroup.querySelectorAll('button')].map((button) => button.textContent))
      .toEqual(['Skills', 'MCP', 'Tools & hooks']);
    // About & updates sits outside every group as a clickable top-level leaf.
    const aboutLeaf = container.querySelector('[data-settings-nav-ungrouped="about"]');
    expect(aboutLeaf).not.toBeNull();
    expect(aboutLeaf!.closest('[data-settings-nav-group]')).toBeNull();
    expect(aboutLeaf!.querySelector('button')!.textContent).toBe('About & updates');
  });

  it('highlights only the active leaf and navigates on click', async () => {
    const visited: string[] = [];
    const container = await render(
      <SettingsNav active="skills" searchFocusToken={null} onNavigate={(id) => { visited.push(id); }} onSearchHit={noop} />,
    );
    const active = [...container.querySelectorAll('button')].filter((button) => button.className.includes('text-accent'));
    expect(active.map((button) => button.textContent)).toEqual(['Skills']);
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
    expect(hits[0]!.textContent).toBe('Application›General›Appearance');
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

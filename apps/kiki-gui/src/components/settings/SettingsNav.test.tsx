// @vitest-environment jsdom

/**
 * Grouped settings navigation (redesign batch 1): visual group headers,
 * breadcrumb search hits, and the unknown-section notice with search guidance.
 */

import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { writeIaPrototypeMode } from '../../lib/settingsIaPrototype';
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

async function render(node: React.ReactNode, queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      // The navigation reads the installed-plugin cache to name what can be
      // opened. A harness with no server gives it an empty cache rather than a
      // missing provider, which is the state it renders in before a connection.
      <QueryClientProvider client={queryClient}>
        <I18nProvider>{node}</I18nProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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
  it('ignores stored prototype mode, renders no picker, keeps the 7 groups, and uses real names for renamed leaves', async () => {
    writeIaPrototypeMode('objects');
    try {
      const container = await render(
        <SettingsNav active="connection" searchFocusToken={null} onNavigate={noop} onSearchHit={noop} />,
      );
      // No experimental picker rendered
      expect(container.querySelector('[data-settings-ia-picker]')).toBeNull();

      // Groups stay the 7 purpose groups
      const groups = [...container.querySelectorAll('[data-settings-nav-group]')];
      expect(groups.map((group) => group.getAttribute('data-settings-nav-group')))
        .toEqual(['device', 'models-agents', 'sessions-work', 'capabilities', 'rules', 'connection', 'advanced']);

      // Assert leaf labels for connection, connection-services, extensions, browser-control, and developer
      const leafText = (id: string) => container.querySelector(`[data-settings-nav-leaf="${id}"]`)?.textContent?.trim();
      expect(leafText('connection')).toBe('Server connection');
      expect(leafText('connection-services')).toBe('Access from elsewhere');
      expect(leafText('extensions')).toBe('Extensions & tools');
      expect(leafText('browser-control')).toBe('Browser & computer');
      expect(leafText('developer')).toBe('Developer & labs');
    } finally {
      writeIaPrototypeMode(null);
    }
  });

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
      .toEqual(['device', 'models-agents', 'sessions-work', 'capabilities', 'rules', 'connection', 'advanced']);
    expect(groups.map((group) => group.querySelector('p')?.textContent))
      .toEqual(['App', 'Models & agents', 'Sessions & work', 'Capabilities', 'Permissions & security', 'Connection & remote', 'Advanced']);
    for (const group of groups) expect(group.querySelector(':scope > button')).toBeNull();
    const leaves = (index: number) => [...groups[index]!.querySelectorAll('[data-settings-nav-leaf]')].map((leaf) => leaf.getAttribute('data-settings-nav-leaf'));
    expect(leaves(0)).toEqual(['general', 'appearance', 'shortcuts', 'notifications']);
    expect(leaves(1)).toEqual(['ai', 'agents']);
    expect(leaves(2)).toEqual(['sessions', 'workspaces', 'memory']);
    // Hooks are automation: they sit with the agent's capabilities, not rules.
    expect(leaves(3)).toEqual(['extensions', 'search', 'browser-control', 'hooks']);
    expect(leaves(4)).toEqual(['permissions']);
    // Spaces and external services sit with the ways of reaching a server;
    // workspaces with the sessions that run in them.
    expect(leaves(5)).toEqual(['connection', 'spaces', 'ssh', 'connection-services']);
    expect(leaves(6)).toEqual(['about', 'developer']);
  });

  it('highlights only the active leaf and navigates on click', async () => {
    const visited: string[] = [];
    const container = await render(
      <SettingsNav active="extensions" searchFocusToken={null} onNavigate={(id) => { visited.push(id); }} onSearchHit={noop} />,
    );
    const active = [...container.querySelectorAll('[aria-current="page"]')];
    expect(active.map((button) => button.textContent)).toEqual(['Extensions & tools']);
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

  it('keeps the tree at two levels: a page\'s tabs and an open plugin never become nav children', async () => {
    const container = await render(
      <SettingsNav active="search" searchFocusToken={null} onNavigate={noop} onSearchHit={noop} />,
    );
    expect(container.querySelector('[data-settings-nav-subtabs]')).toBeNull();
    expect(container.querySelector('[data-settings-nav-plugin]')).toBeNull();
    // The leaf itself stays the one clickable row and still highlights.
    expect(container.querySelector('[data-settings-nav-leaf="search"]')?.getAttribute('aria-current')).toBe('page');
  });

  it('updates nav error indicators after a background failure, recovery and removal without navigation', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = await render(
      <SettingsNav active="general" searchFocusToken={null} onNavigate={noop} onSearchHit={noop} />,
      queryClient,
    );
    expect(container.querySelector('[data-settings-nav-error="ai"]')).toBeNull();
    const fail = async () => {
      await queryClient.fetchQuery({ queryKey: ['config'], queryFn: async () => { throw new Error('connection unavailable'); } }).catch(() => undefined);
    };
    await act(fail);
    expect(container.querySelector('[data-settings-nav-error="ai"]')).not.toBeNull();
    await act(async () => { queryClient.setQueryData(['config'], { raw: {} }); });
    expect(container.querySelector('[data-settings-nav-error="ai"]')).toBeNull();
    await act(fail);
    expect(container.querySelector('[data-settings-nav-error="ai"]')).not.toBeNull();
    await act(async () => { queryClient.removeQueries({ queryKey: ['config'] }); });
    expect(container.querySelector('[data-settings-nav-error="ai"]')).toBeNull();
    expect(container.querySelector('[aria-current="page"]')?.getAttribute('data-settings-nav-leaf')).toBe('general');
  });

  it('marks a nav leaf with data-settings-nav-error when its cached query or installed plugin has an error', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['plugins', 'local'], {
      plugins: [{ id: 'broken-plugin', displayName: 'Broken', state: 'error', enabled: true }],
    });
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <SettingsNav active="general" searchFocusToken={null} onNavigate={noop} onSearchHit={noop} />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    expect(container.querySelector('[data-settings-nav-error="extensions"]')).not.toBeNull();
    expect(container.querySelector('[data-settings-nav-error="general"]')).toBeNull();
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
    expect(hits).toEqual(['extensions']);
  });
});

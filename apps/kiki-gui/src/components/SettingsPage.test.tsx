// @vitest-environment jsdom

/**
 * SettingsPage scope header: a workspace-scoped section (Capabilities' MCP
 * card) reports its selected workspace, and the header names it in lockstep
 * with the card-level selector.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { SettingsPage } from './SettingsPage';

const WORKSPACES = {
  items: [
    { id: 'ws-alpha', name: 'Alpha', root: '/tmp/alpha', last_opened_at: '2026-09-01T00:00:00Z', pinned: false },
    { id: 'ws-beta', name: 'Beta', root: '/tmp/beta', last_opened_at: '2026-08-01T00:00:00Z', pinned: false },
  ],
};

const client = {
  getConfig: vi.fn(async () => ({})),
  meta: vi.fn(async () => ({ experimental_flags: {} })),
  listWorkspaces: vi.fn(async () => WORKSPACES),
  listManagedMcpServers: vi.fn(async () => []),
  listTools: vi.fn(async () => ({ tools: [] })),
};

vi.mock('../state/connection', () => ({
  useConnection: () => ({ client }),
}));

vi.mock('../host', () => ({
  useHost: () => ({ kind: 'browser' }),
}));

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

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderSettings(initialPath: string): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <MemoryRouter initialEntries={[initialPath]}>
            <Routes>
              <Route path="/settings/:section?" element={<SettingsPage onToggleSidebar={() => {}} />} />
            </Routes>
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
  return container;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function scopeHeader(container: HTMLDivElement): HTMLElement {
  return container.querySelector<HTMLElement>('[data-settings-scope-header]')!;
}

describe('SettingsPage scope header workspace sync', () => {
  it('names the workspace the MCP card targets and follows selector changes', async () => {
    const container = await renderSettings('/settings/capabilities');
    const header = scopeHeader(container);
    expect(header.getAttribute('data-settings-scope-header')).toBe('server+workspace');
    // Default selection: the most recently opened workspace.
    expect(header.textContent).toContain('Workspace · Alpha');

    // Switch the card-level workspace selector; the page header follows.
    await click(container.querySelector('#workspace-mcp-select')!);
    const option = [...container.querySelectorAll('[role="option"]')]
      .find((element) => element.textContent?.includes('Beta'))!;
    await click(option);
    await flush();
    expect(scopeHeader(container).textContent).toContain('Workspace · Beta');
    expect(scopeHeader(container).textContent).not.toContain('Workspace · Alpha');
  });

  it('shows no workspace name on pages without a workspace surface', async () => {
    const container = await renderSettings('/settings/ai?tab=models');
    const header = scopeHeader(container);
    expect(header.getAttribute('data-settings-scope-header')).toBe('server');
    expect(header.textContent).not.toContain('Workspace ·');
  });

  it('mounts the catalog-refresh card on the models tab of the merged ai entry', async () => {
    const container = await renderSettings('/settings/ai?tab=models');
    const card = container.querySelector('#st-card-catalog-refresh');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('Model catalog refresh');
    expect(card!.textContent).toContain('Refresh model catalog when the server starts');
  });
});

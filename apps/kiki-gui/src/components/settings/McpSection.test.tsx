// @vitest-environment jsdom

/**
 * The MCP settings leaf, reached the way one workspace's own page reaches it:
 * `/settings/mcp?workspace=<id>`.
 *
 * The one thing this leaf can get wrong invisibly is which workspace it read.
 * The management plane addresses project layers by cwd, so a leaf that ignored
 * the query would show the home configuration — or the most recently opened
 * workspace's — under a link that named a different one, and every edit made
 * from there would land in the wrong place while looking right. These cases
 * read the actual request rather than the rendered rows.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpManagedServer } from '@kiki/session-core/transport';
import { I18nProvider } from '../../i18n';
import { McpSection } from './McpSection';

const list = vi.hoisted(() => vi.fn());
const listWorkspaces = vi.hoisted(() => vi.fn());
const getConfig = vi.hoisted(() => vi.fn());

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    klient: { global: { mcp: { list } } },
    client: { listWorkspaces, getConfig },
    scopeId: 'fixture-server',
  }),
}));

const RECENT = { id: 'wd_recent_000000000000', name: 'Recent', root: '/fixture/recent', last_opened_at: '2026-09-30T00:00:00Z' };
const TWO = { id: 'wd_two_111111111111', name: 'Two', root: '/fixture/two', last_opened_at: '2026-01-02T00:00:00Z' };

/** One entry this server owns (editable, writes to the global config) and one it
 *  only reads from a plugin. */
const ENTRIES: readonly McpManagedServer[] = [
  {
    name: 'remote',
    config: { transport: 'http', url: 'https://mcp.example.test/mcp', headerKeys: ['Authorization'] },
    source: 'global', origin: '/home/.kiki/mcp.json', mutable: true,
  },
  {
    name: 'from-plugin',
    config: { transport: 'sse', url: 'https://plugin.example.test/mcp', headerKeys: [] },
    source: 'plugin', origin: 'fixture-plugin', mutable: false,
  },
];

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  list.mockReset().mockResolvedValue(ENTRIES);
  listWorkspaces.mockReset().mockResolvedValue({ items: [RECENT, TWO] });
  getConfig.mockReset().mockResolvedValue({ mcp: {} });
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
});
afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function render(entry: string): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nProvider><MemoryRouter initialEntries={[entry]}><McpSection /></MemoryRouter></I18nProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); });
  // Two chained reads (the workspace list, then that workspace's entries), so
  // the page needs more than one flush to reach a settled state.
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  return container;
}

describe('the MCP leaf a workspace page links to', () => {
  it('reads the linked workspace’s own root, not the most recently opened one', async () => {
    const container = await render(`/settings/mcp?workspace=${encodeURIComponent(TWO.id)}`);
    // The request, not the link: this is what proves the scope.
    expect(list).toHaveBeenCalledWith({ cwd: TWO.root });
    expect(list).not.toHaveBeenCalledWith({ cwd: RECENT.root });
    // Nothing fell back to the home configuration either.
    expect(list.mock.calls.every((call) => (call[0] as { cwd?: string }).cwd !== undefined)).toBe(true);
    // And the page says whose entries these are, rather than leaving the scope
    // to the frame's one-line status.
    expect(container.querySelector('[data-mcp-workspace-name]')?.textContent).toBe('Two');
    expect(container.querySelector('[data-mcp-workspace-root]')?.textContent).toBe(TWO.root);
  });

  it('keeps every entry’s real origin and mutability', async () => {
    const container = await render(`/settings/mcp?workspace=${encodeURIComponent(TWO.id)}`);
    const owned = container.querySelector('[data-mcp-server="remote"]')!;
    const fromPlugin = container.querySelector('[data-mcp-server="from-plugin"]')!;
    // An entry this server owns offers the edit; a plugin's does not, and says
    // why. Read-only is a fact of the entry, not of where the page was opened.
    expect(owned.querySelector('button[aria-label="Edit remote"]')).not.toBeNull();
    expect(owned.textContent).not.toContain('Read-only');
    expect(fromPlugin.querySelector('button[aria-label="Edit from-plugin"]')).toBeNull();
    expect(fromPlugin.textContent).toContain('Read-only');
  });

  it('does not read anything for a workspace this server does not list', async () => {
    const container = await render('/settings/mcp?workspace=wd_gone_222222222222');
    // No quiet fallback: not the recent workspace, not the home config.
    expect(list).not.toHaveBeenCalled();
    expect(container.querySelector('[data-mcp-workspace-missing]')).not.toBeNull();
    expect(container.querySelector('[data-mcp-server]')).toBeNull();
  });

  it('leaves the leaf as it was when no workspace is named', async () => {
    const container = await render('/settings/mcp');
    expect(list).not.toHaveBeenCalled();
    expect(container.querySelector('[data-mcp-workspace-missing]')).toBeNull();
    // The server-wide defaults are still on the leaf; they are not a workspace's.
    expect(container.querySelector('#st-card-mcp-timeouts')).not.toBeNull();
  });
});

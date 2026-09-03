// @vitest-environment jsdom

/**
 * SettingsPage scope header: a workspace-scoped section (Skills' catalog,
 * MCP's config card) reports its selected workspace, and the header names it
 * in lockstep with the card-level selector. Also covers the batch-3 leaf
 * mounts and the retired-capabilities legacy redirects.
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
  listMcpServers: vi.fn(async () => ({ servers: [] })),
  listPlugins: vi.fn(async () => ({ plugins: [] })),
  listWorkspaceSkills: vi.fn(async () => ({ skills: [] })),
  listTools: vi.fn(async () => ({ tools: [] })),
  listNamedAgentProfiles: vi.fn(async () => ({ items: [] })),
  patchConfig: vi.fn(async () => ({})),
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
  // jsdom has no CSS.escape; the card ids are already selector-safe.
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  // …and no scrollIntoView, which the search-flash scroll runs on a card hit.
  Element.prototype.scrollIntoView ??= () => {};
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

async function renderSettings(initialPath: string, handles?: { queryClient?: QueryClient }): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (handles !== undefined) handles.queryClient = queryClient;
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
    const container = await renderSettings('/settings/mcp');
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

describe('SettingsPage batch-3 leaves', () => {
  it('mounts the skills leaf with defaults and the workspace skill catalog', async () => {
    const container = await renderSettings('/settings/skills');
    expect(container.querySelector('#st-card-caps')).not.toBeNull();
    expect(container.querySelector('#st-card-skill-catalog')).not.toBeNull();
    expect(container.querySelector('#workspace-skills-select')).not.toBeNull();
    expect(scopeHeader(container).getAttribute('data-settings-scope-header')).toBe('server+workspace');
    expect(scopeHeader(container).textContent).toContain('Workspace · Alpha');
  });

  it('mounts the mcp leaf with config, status, and timeouts cards', async () => {
    const container = await renderSettings('/settings/mcp');
    expect(container.querySelector('#st-card-mcp')).not.toBeNull();
    expect(container.querySelector('#st-card-mcp-status')).not.toBeNull();
    expect(container.querySelector('#st-card-mcp-timeouts')).not.toBeNull();
  });

  it('mounts the automation leaf with tool policy and hooks cards', async () => {
    const container = await renderSettings('/settings/automation');
    expect(container.querySelector('#st-card-tools')).not.toBeNull();
    expect(container.querySelector('#st-card-hooks')).not.toBeNull();
  });

  it('mounts the runtime leaf without the tools card or MCP timeout fields', async () => {
    const container = await renderSettings('/settings/runtime');
    expect(container.querySelector('#st-card-runtime')).not.toBeNull();
    expect(container.querySelector('#st-card-tools')).toBeNull();
  });

  it('mounts the experimental and advanced leaves under Data & advanced', async () => {
    for (const [section, cardId] of [
      ['experimental', 'st-card-experimental'],
      ['advanced', 'st-card-advanced'],
    ] as const) {
      const container = await renderSettings(`/settings/${section}`);
      expect(container.querySelector(`#${cardId}`), section).not.toBeNull();
    }
  });

  it('mounts the subagents leaf with profiles, governance, and the timeout card', async () => {
    const container = await renderSettings('/settings/subagents');
    expect(container.querySelector('#st-card-subagent-profiles')).not.toBeNull();
    expect(container.querySelector('#st-card-subagents')).not.toBeNull();
    expect(container.querySelector('#st-card-subagent-timeout')).not.toBeNull();
  });

  it('keeps only the main-agent card on the agents leaf', async () => {
    const container = await renderSettings('/settings/agents');
    expect(container.querySelector('#st-card-main-agents')).not.toBeNull();
    expect(container.querySelector('#st-card-subagent-profiles')).toBeNull();
    expect(container.querySelector('#st-card-sidecar')).toBeNull();
  });

  it('redirects bare /settings/capabilities to the skills leaf', async () => {
    const container = await renderSettings('/settings/capabilities');
    await flush();
    expect(container.querySelector('#st-card-caps')).not.toBeNull();
    expect(container.querySelector('#st-card-skill-catalog')).not.toBeNull();
  });

  it('follows a legacy capabilities card hash to its new leaf', async () => {
    const container = await renderSettings('/settings/capabilities#st-card-mcp');
    await flush();
    expect(container.querySelector('#st-card-mcp')).not.toBeNull();
    expect(container.querySelector('#st-card-mcp-timeouts')).not.toBeNull();
  });

  it('lands the dissolved sidecar card on the subagent timeout card', async () => {
    const container = await renderSettings('/settings/agents#st-card-sidecar');
    await flush();
    expect(container.querySelector('#st-card-subagent-timeout')).not.toBeNull();
    expect(container.querySelector('#st-card-sidecar')).toBeNull();
  });

  it('mounts the plugins leaf with the installed-plugins card', async () => {
    const container = await renderSettings('/settings/plugins');
    await flush();
    expect(container.querySelector('#st-card-plugins')).not.toBeNull();
    expect(client.listPlugins).toHaveBeenCalled();
  });

  it('keeps the deep-link query on the capabilities signpost links', async () => {
    const container = await renderSettings('/settings/skills?from=capabilities&workspace=ws-beta&token=tok');
    await flush();
    const note = container.querySelector('[data-capabilities-shim-note]');
    expect(note).not.toBeNull();
    const links = [...note!.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href') ?? '');
    expect(links.length).toBe(3);
    for (const href of links) {
      expect(href).toContain('workspace=ws-beta');
      expect(href).toContain('token=tok');
      expect(href).not.toContain('from=capabilities');
    }
    expect(links[0]).toMatch(/^\/settings\/skills\?/);
    expect(links[1]).toMatch(/^\/settings\/mcp\?/);
    expect(links[2]).toMatch(/^\/settings\/plugins\?/);
  });

  it('saves tool policy with the narrow patch and invalidates only the tools query', async () => {
    const handles: { queryClient?: QueryClient } = {};
    const container = await renderSettings('/settings/automation', handles);
    await flush();
    const queryClient = handles.queryClient!;
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    client.patchConfig.mockClear();
    const card = container.querySelector('#st-card-tools')!;
    const saveButton = [...card.querySelectorAll('button')].find((button) => button.textContent === 'Save tool policy')!;
    await click(saveButton);
    await flush();
    // The save is the narrow tools-domain patch, and the tools list (whose
    // descriptor `active` flags derive from the policy) is invalidated —
    // mcp-servers is not, this save never touches the mcp domain.
    expect(client.patchConfig).toHaveBeenCalledWith({
      tools: { enabled: [], disabled: [] },
      replace_domains: ['tools'],
    });
    const invalidated = invalidateSpy.mock.calls.map(([arg]) => (arg as { queryKey?: unknown[] }).queryKey);
    expect(invalidated).toContainEqual(['tools']);
    expect(invalidated).not.toContainEqual(['mcp-servers']);
  });
});

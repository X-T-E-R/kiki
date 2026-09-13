// @vitest-environment jsdom

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SETTINGS_SEARCH_SPEC } from '@kiki/session-core/settings';
import { I18nProvider } from '../i18n';
import { SettingsPage } from './SettingsPage';

const WORKSPACES = {
  items: [
    { id: 'ws-alpha', name: 'Alpha', root: '/tmp/alpha', last_opened_at: '2026-09-01T00:00:00Z', pinned: false },
    { id: 'ws-beta', name: 'Beta', root: '/tmp/beta', last_opened_at: '2026-08-01T00:00:00Z', pinned: false },
  ],
};

const MCP_ENTRY = {
  name: 'old-server',
  config: { transport: 'stdio' as const, command: 'node', args: ['server.js'] },
  source: 'global' as const,
  origin: '/tmp/mcp.json',
  mutable: true,
};

const klient = {
  global: {
    board: { read: vi.fn() },
    mcp: {
      list: vi.fn(async (): Promise<readonly typeof MCP_ENTRY[]> => []),
      add: vi.fn(async (): Promise<readonly typeof MCP_ENTRY[]> => []),
      update: vi.fn(async (): Promise<readonly typeof MCP_ENTRY[]> => []),
      remove: vi.fn(async (): Promise<readonly typeof MCP_ENTRY[]> => []),
      test: vi.fn(async () => ({ success: true, output: '' })),
    },
  },
};

const client = {
  getConfig: vi.fn(async () => ({})),
  meta: vi.fn(async (): Promise<{ experimental_flags?: Record<string, boolean> }> => ({
    experimental_flags: {
      'tool-select': true,
      task_wait: true,
      search_worker: true,
      persistence_minidb_readmodel: true,
      auto_session_title: true,
      subagent_release_idle: true,
      'agent-profile-routes': true,
      external_delegation_mcp: true,
      task_board: true,
    },
  })),
  listWorkspaces: vi.fn(async () => WORKSPACES),
  listMcpServers: vi.fn(async () => ({ servers: [] })),
  listPlugins: vi.fn(async () => ({ plugins: [] })),
  listPluginMarketplace: vi.fn(async () => ({ configured: false, entries: [] })),
  getPlugin: vi.fn(async () => ({
    id: 'fixture-plugin',
    displayName: 'fixture-plugin',
    enabled: true,
    state: 'ok',
    skillCount: 0,
    mcpServerCount: 0,
    enabledMcpServerCount: 0,
    hookCount: 0,
    commandCount: 0,
    hasErrors: false,
    source: 'local-path',
    root: '/tmp/plugin',
    installedAt: '2026-01-01T00:00:00.000Z',
    mcpServers: [],
    diagnostics: [],
  })),
  installPlugin: vi.fn(async () => ({ id: 'installed' })),
  setPluginEnabled: vi.fn(async () => ({ ok: true })),
  removePlugin: vi.fn(async () => ({ ok: true })),
  listWorkspaceSkills: vi.fn(async () => ({ skills: [] })),
  listTools: vi.fn(async () => ({ tools: [] })),
  listNamedAgentProfiles: vi.fn(async () => ({ items: [] })),
  patchConfig: vi.fn(async () => ({})),
};

vi.mock('../state/connection', () => ({
  useConnection: () => ({ client, klient }),
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

beforeEach(() => {
  klient.global.mcp.list.mockReset();
  klient.global.mcp.add.mockReset();
  klient.global.mcp.update.mockReset();
  klient.global.mcp.remove.mockReset();
  klient.global.mcp.test.mockReset();
  klient.global.mcp.list.mockResolvedValue([]);
  klient.global.mcp.add.mockResolvedValue([]);
  klient.global.mcp.update.mockResolvedValue([]);
  klient.global.mcp.remove.mockResolvedValue([]);
  klient.global.mcp.test.mockResolvedValue({ success: true, output: '' });
  client.listNamedAgentProfiles.mockClear();
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

async function setInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function setTextarea(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
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
    expect(klient.global.mcp.list).toHaveBeenCalledWith({ cwd: '/tmp/alpha' });
    expect(klient.global.mcp.list).toHaveBeenCalledWith({ cwd: '/tmp/beta' });
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

  it('tests a draft and renames it by adding the new name before removing the old name', async () => {
    klient.global.mcp.list.mockResolvedValue([MCP_ENTRY]);
    klient.global.mcp.add.mockResolvedValue([MCP_ENTRY]);
    const container = await renderSettings('/settings/mcp');
    const card = container.querySelector('#st-card-mcp')!;
    const edit = [...card.querySelectorAll('button')].find((button) => button.textContent === 'Edit')!;
    await click(edit);
    const fieldset = card.querySelector('fieldset')!;
    await setInput(fieldset.querySelector('input')!, 'new-server');
    await click(fieldset.querySelectorAll('button')[1]!);
    await flush();

    expect(klient.global.mcp.test).toHaveBeenCalledWith({
      server: { name: 'new-server', transport: 'stdio', command: 'node', args: ['server.js'] },
      cwd: '/tmp/alpha',
    });

    await click(fieldset.querySelectorAll('button')[0]!);
    await flush();

    expect(klient.global.mcp.add).toHaveBeenCalledWith({
      server: { name: 'new-server', transport: 'stdio', command: 'node', args: ['server.js'] },
      cwd: '/tmp/alpha',
    });
    expect(klient.global.mcp.remove).toHaveBeenCalledWith({ name: 'old-server', cwd: '/tmp/alpha' });
    expect(klient.global.mcp.add.mock.invocationCallOrder[0]).toBeLessThan(
      klient.global.mcp.remove.mock.invocationCallOrder[0]!,
    );
    expect(klient.global.mcp.update).not.toHaveBeenCalled();
  });

  it('updates an MCP server through klient.global.mcp.update', async () => {
    klient.global.mcp.list.mockResolvedValue([MCP_ENTRY]);
    const container = await renderSettings('/settings/mcp');
    const card = container.querySelector('#st-card-mcp')!;
    const edit = [...card.querySelectorAll('button')].find((button) => button.textContent === 'Edit')!;
    await click(edit);
    const save = card.querySelector('fieldset')!.querySelectorAll('button')[0]!;
    await click(save);
    await flush();

    expect(klient.global.mcp.update).toHaveBeenCalledWith({
      server: { name: 'old-server', transport: 'stdio', command: 'node', args: ['server.js'] },
      cwd: '/tmp/alpha',
    });
    expect(klient.global.mcp.add).not.toHaveBeenCalled();
    expect(klient.global.mcp.remove).not.toHaveBeenCalled();
  });

  it('saves MCP timeouts only after an edit and keeps the dirty draft across config refetches', async () => {
    client.getConfig.mockResolvedValueOnce({ mcp: { startupTimeoutMs: 30000, toolTimeoutMs: 60000 } });
    client.patchConfig.mockResolvedValueOnce({ mcp: { startupTimeoutMs: 45000, toolTimeoutMs: 60000 } });
    const handles: { queryClient?: QueryClient } = {};
    const container = await renderSettings('/settings/mcp', handles);
    const card = container.querySelector('#st-card-mcp-timeouts')!;
    const inputs = card.querySelectorAll('input');
    const startup = inputs[0]!;
    expect(startup.value).toBe('30000');
    expect(inputs[1]!.value).toBe('60000');
    const save = card.querySelector('button')!;
    expect(save.disabled).toBe(true);

    await setInput(startup, '45000');
    expect(save.disabled).toBe(false);

    // A shared-config echo while dirty must not clobber the draft.
    await act(async () => {
      handles.queryClient!.setQueryData(['config'], { mcp: { startupTimeoutMs: 99000 } });
    });
    expect(startup.value).toBe('45000');

    await click(save);
    await flush();
    expect(client.patchConfig).toHaveBeenCalledWith({
      mcp: { startup_timeout_ms: 45000, tool_timeout_ms: 60000 },
      replace_domains: ['mcp'],
    });
    expect(save.disabled).toBe(true);
    expect(card.textContent).toContain('MCP timeouts saved and echoed by the server.');
  });

  it('mounts the automation leaf with tool policy and hooks cards', async () => {
    const container = await renderSettings('/settings/automation');
    expect(container.querySelector('#st-card-tools')).not.toBeNull();
    expect(container.querySelector('#st-card-tool-experiments')).not.toBeNull();
    expect(container.querySelector('#st-card-hooks')).not.toBeNull();
    expect(scopeHeader(container).textContent).toContain('Manage tool permissions and automatic actions triggered by events.');
    expect(scopeHeader(container).textContent).toContain('Server');
  });

  it('mounts the runtime leaf without the tools card or MCP timeout fields', async () => {
    const container = await renderSettings('/settings/runtime');
    expect(container.querySelector('#st-card-runtime')).not.toBeNull();
    expect(container.querySelector('#st-card-tools')).toBeNull();
    expect(container.querySelector('#st-card-runtime')!.textContent).toContain('Server-side knobs for scheduling, communication, resources, and identity.');
  });

  it('omits an empty scoped task feature widget when the server reports no flag', async () => {
    client.meta.mockResolvedValueOnce({ experimental_flags: {} });
    const container = await renderSettings('/settings/tasks');
    expect(container.querySelector('#st-card-agent-board')).not.toBeNull();
    expect(container.querySelector('#st-card-defaults')).not.toBeNull();
    expect(container.querySelector('#st-card-task-board')).toBeNull();
    expect(container.textContent).not.toContain('This server did not report any experimental flags.');
  });

  it('redirects the retired experimental URL to the advanced page', async () => {
    const container = await renderSettings('/settings/experimental');
    expect(container.querySelector('#st-card-advanced')).not.toBeNull();
    expect(container.querySelector('#st-card-performance-storage')).not.toBeNull();
    expect(container.querySelector('#st-card-experimental')).toBeNull();
    expect(scopeHeader(container).textContent).toContain('advanced configuration and performance settings');
    expect(container.textContent).not.toContain('Tool selection and TaskWait are in Tools & automations');
  });

  it('mounts the advanced page with engine domains and collapsed performance settings', async () => {
    const container = await renderSettings('/settings/advanced');
    const card = container.querySelector('#st-card-advanced')!;
    expect(card).not.toBeNull();
    expect(scopeHeader(container).textContent).toContain('advanced configuration and performance settings');
    expect(card.textContent).toContain('the server validates each domain');
    expect(card.textContent).not.toContain('kap-server');
    const performance = container.querySelector('#st-card-performance-storage')!;
    expect(performance.querySelector('details')?.open).toBe(false);
  });

  it('saves advanced settings without the retired services domain', async () => {
    client.getConfig.mockResolvedValueOnce({
      permission: { mode: 'manual' },
      services: { legacy: true },
      loop_control: { max_steps_per_turn: 12 },
      background: { max_running_tasks: 2 },
    });
    client.patchConfig.mockResolvedValueOnce({
      permission: { mode: 'manual' },
      loop_control: { max_steps_per_turn: 12 },
      background: { max_running_tasks: 2 },
    });
    client.patchConfig.mockClear();
    const container = await renderSettings('/settings/advanced');
    const card = container.querySelector('#st-card-advanced')!;
    const textarea = card.querySelector('textarea')!;
    expect(textarea.value).not.toContain('services');

    const saveButton = [...card.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save advanced domains',
    )!;
    await setTextarea(textarea, `${textarea.value}\n`);
    await click(saveButton);
    await flush();

    expect(client.patchConfig).toHaveBeenCalledWith({
      permission: { mode: 'manual' },
      loop_control: { max_steps_per_turn: 12 },
      background: { max_running_tasks: 2 },
    });
  });

  it('mounts the subagents leaf with profiles, governance, and the timeout card', async () => {
    const container = await renderSettings('/settings/subagents');
    expect(container.querySelector('#st-card-subagent-profiles')).not.toBeNull();
    expect(container.querySelector('#st-card-subagents')).not.toBeNull();
    expect(container.querySelector('#st-card-subagent-timeout')).not.toBeNull();
  });

  it('keeps only the main-agent card on the agents leaf and uses the workspace catalog', async () => {
    const container = await renderSettings('/settings/agents');
    await flush();
    expect(container.querySelector('#st-card-main-agents')).not.toBeNull();
    expect(container.querySelector('#st-card-subagent-profiles')).toBeNull();
    expect(container.querySelector('#st-card-sidecar')).toBeNull();
    expect(client.listNamedAgentProfiles).toHaveBeenCalledWith('ws-alpha');
    expect(client.listNamedAgentProfiles).toHaveBeenCalledWith({ workspace_id: 'ws-alpha', effective: true });
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
    expect(container.querySelector('#st-card-plugins-add')).not.toBeNull();
    expect(client.listPlugins).toHaveBeenCalled();
  });

  it('does not show a relocation announcement on a legacy capabilities URL', async () => {
    const container = await renderSettings('/settings/skills?from=capabilities&workspace=ws-beta&token=tok');
    await flush();
    expect(container.querySelector('[data-capabilities-shim-note]')).toBeNull();
    expect(container.textContent).not.toContain('split into dedicated settings pages');
    expect(container.querySelector('#workspace-skills-select')).not.toBeNull();
  });

  it('saves tool policy with the narrow patch and invalidates only the tools query', async () => {
    const handles: { queryClient?: QueryClient } = {};
    const container = await renderSettings('/settings/automation', handles);
    await flush();
    const queryClient = handles.queryClient!;
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    client.patchConfig.mockClear();
    const card = container.querySelector('#st-card-tools')!;
    const mode = card.querySelector('select')!;
    await act(async () => {
      mode.value = 'allowlist';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      mode.value = 'profile';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    });
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

describe('SettingsPage search ownership', () => {
  it('indexes every card the settings page renders', async () => {
    const general = await renderSettings('/settings/general');
    const agents = await renderSettings('/settings/agents');
    const subagents = await renderSettings('/settings/subagents');
    const mcp = await renderSettings('/settings/mcp');
    const automation = await renderSettings('/settings/automation');
    const tasks = await renderSettings('/settings/tasks');
    const advanced = await renderSettings('/settings/advanced');
    expect(general.querySelector('#st-card-session-title')).not.toBeNull();
    expect(general.querySelector('#st-card-permission-defaults')).not.toBeNull();
    expect(general.querySelector('#st-card-defaults')).toBeNull();
    expect(tasks.querySelector('#st-card-defaults')).not.toBeNull();
    expect(agents.querySelector('#st-card-agent-profile-routes')).not.toBeNull();
    expect(subagents.querySelector('#st-card-subagent-release-idle')).not.toBeNull();
    expect(mcp.querySelector('#st-card-mcp-delegation')).not.toBeNull();
    expect(automation.querySelector('#st-card-tool-experiments')).not.toBeNull();
    expect(tasks.querySelector('#st-card-task-board')).not.toBeNull();
    expect(advanced.querySelector('#st-card-performance-storage')).not.toBeNull();
    const dir = resolve(process.cwd(), 'src/components');
    const rendered = new Set(
      readdirSync(dir, { recursive: true })
        .map((name) => String(name).replaceAll('\\', '/'))
        .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
        .flatMap((name) => [
          ...readFileSync(resolve(dir, name), 'utf8')
            .matchAll(/id="(st-card-[a-z0-9-]+)"/g),
        ])
        .map((match) => match[1]!),
    );
    for (const page of [general, agents, subagents, mcp, automation, tasks, advanced]) {
      for (const card of page.querySelectorAll('[id^="st-card-"]')) rendered.add(card.id);
    }
    expect(rendered.size).toBeGreaterThan(10);
    const indexed = new Set(SETTINGS_SEARCH_SPEC.map((entry) => entry.cardId));
    expect([...rendered].filter((id) => !indexed.has(id))).toEqual([]);
    expect([...indexed].filter((id) => !rendered.has(id))).toEqual([]);
  });
});

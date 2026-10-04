// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NamedAgentProfile, ToolDescriptor } from '@kiki/protocol';
import { I18nProvider } from '../../../i18n';
import { SubagentToolSettingsCard } from './ToolSettingsCard';

const { client, editorProps, guardState } = vi.hoisted(() => ({
  guardState: { value: undefined as { confirmDiscard?: (id: string, action: () => void) => void } | undefined },
  client: {
    getConfig: vi.fn(),
    patchConfig: vi.fn(),
    listTools: vi.fn(),
    listNamedAgentProfiles: vi.fn(),
    updateNamedAgentProfile: vi.fn(),
  },
  editorProps: { profiles: [] as string[] },
}));
vi.mock('../../../state/connection', () => ({ useConnection: () => ({ client }) }));
vi.mock('../../dirtyGuard', () => ({
  useDirtyReporter: vi.fn(),
  useGuardedNavigate: () => vi.fn(),
  useDirtyGuard: () => guardState.value,
}));
vi.mock('../AgentProfileEditorDialog', () => ({
  AgentProfileEditorDialog: ({ profile }: { profile: NamedAgentProfile }) => {
    editorProps.profiles.push(profile.name);
    return <div data-profile-editor={profile.name} />;
  },
}));

const TOOL = (name: string, source: ToolDescriptor['source'], description: string, extra: Partial<ToolDescriptor> = {}): ToolDescriptor => ({
  name, source, description, input_schema: {}, ...extra,
});

const CATALOG: ToolDescriptor[] = [
  TOOL('Bash', 'builtin', 'Run a shell command.'),
  TOOL('BoardRead', 'builtin', 'Read the task board.'),
  TOOL('BoardWrite', 'builtin', 'Write the task board.'),
  TOOL('Read', 'builtin', 'Read a file.'),
  TOOL('Write', 'builtin', 'Write a file.'),
  TOOL('AskUserQuestion', 'builtin', 'Ask the user to choose.'),
  TOOL('MemoryRead', 'builtin', 'Read a saved memory.'),
  TOOL('MemoryWrite', 'builtin', 'Write a memory.'),
  TOOL('ThreadRead', 'builtin', 'Read another thread.'),
  TOOL('ThreadSend', 'builtin', 'Send to another thread.'),
  TOOL('ThreadWait', 'builtin', 'Wait for another thread.'),
  TOOL('mcp__fixture-fs__read_file', 'mcp', 'Read a file through MCP.', { mcp_server_id: 'fixture-fs' }),
];

const general: NamedAgentProfile = {
  name: 'general', main: false, source: 'builtin', description: 'General subagent', disabled: false, routes: [],
};
const explore: NamedAgentProfile = {
  name: 'explore', main: false, source: 'user', source_file: '/fixture/agents/explore.md', workspace_id: 'ws-fixture',
  description: 'Explore subagent', disabled: false, routes: [], tools: ['Bash', 'BoardRead'], disallowed_tools: ['Write'],
};

let root: Root;
let container: HTMLDivElement;
let queries: QueryClient;

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function catalog(items: readonly NamedAgentProfile[]) {
  return { items: [...items] };
}

beforeEach(() => {
  vi.resetAllMocks();
  editorProps.profiles = [];
  // The app shell asks before a draft is replaced; tests pick confirm or cancel.
  guardState.value = { confirmDiscard: (_id, action) => { action(); } };
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client.getConfig.mockResolvedValue({});
  client.listTools.mockResolvedValue({ tools: CATALOG });
  client.listNamedAgentProfiles.mockResolvedValue(catalog([general, explore]));
  client.patchConfig.mockImplementation(async (patch: { subagent?: { allowed_tools?: string[] } }) => ({
    subagent: { allowedTools: patch.subagent?.allowed_tools ?? [] },
  }));
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); queries.clear(); container.remove(); });

async function render() {
  await act(async () => root.render(
    <QueryClientProvider client={queries}><I18nProvider><SubagentToolSettingsCard /></I18nProvider></QueryClientProvider>,
  ));
  await settle();
}

/** A stateful stand-in for the agent catalog: a write lands in it, and every read returns it. */
function profileStore(initial: readonly NamedAgentProfile[]) {
  let items = [...initial];
  client.listNamedAgentProfiles.mockImplementation(async () => ({ items: items.map((item) => ({ ...item })), complete: true }));
  client.updateNamedAgentProfile.mockImplementation(async (name: string, body: Record<string, unknown>) => {
    const current = items.find((item) => item.name === name && item.source_file !== undefined)
      ?? items.find((item) => item.name === name)!;
    const next = { ...current } as Record<string, unknown>;
    for (const [key, value] of Object.entries(body)) {
      if (['scope', 'workspace_id', 'source_file'].includes(key)) continue;
      // On the wire an absent key means "unchanged"; only null removes a field.
      if (value === undefined) continue;
      if (value === null) delete next[key];
      else next[key] = value;
    }
    items = items.map((item) => (item === current ? next as unknown as NamedAgentProfile : item));
    return next as unknown as NamedAgentProfile;
  });
}

const row = (name: string) => container.querySelector<HTMLElement>(`[data-tool-row="${name}"]`);
const rowNames = () => [...container.querySelectorAll<HTMLElement>('[data-tool-row]')].map((element) => element.dataset['toolRow'] ?? '');
const detail = () => container.querySelector<HTMLElement>('[data-tool-detail]');
const footer = () => container.querySelector<HTMLButtonElement>('[data-settings-draft="subagent-tool-draft"] button');
const rowReason = (name: string) => row(name)!.querySelector('button')!.getAttribute('title');
const rowAction = (name: string, action: 'allow' | 'deny' | 'editor') => container.querySelector<HTMLButtonElement>(`[data-tool-${action}="${name}"]`);

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

async function selectObject(name: string, fileHint?: string) {
  await act(async () => { container.querySelector<HTMLButtonElement>('#subagent-tools-object')!.click(); });
  // Several objects can share a name; the title carries the identity.
  const option = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((candidate) => {
      const title = candidate.getAttribute('title') ?? '';
      const named = title === name || title.startsWith(`${name} · `);
      return named && (fileHint === undefined || title.includes(fileHint));
    })!;
  await act(async () => { option.click(); });
  await settle();
}

async function openTool(name: string) {
  await act(async () => { row(name)!.querySelector<HTMLButtonElement>('button')!.click(); });
  await settle();
}

async function save() {
  await act(async () => { footer()!.click(); });
  await settle();
}

describe('subagent tool settings', () => {
  it('reads the default rule as one row per tool with only the opt-ins editable', async () => {
    await render();
    expect(container.querySelector('#st-card-subagent-tool-defaults')).not.toBeNull();
    expect(container.querySelector<HTMLElement>('[data-subagent-tools-object]')?.dataset['subagentToolsObject']).toBe('__default__');
    expect(container.querySelector('[data-subagent-tools-object-source]')?.textContent).toContain('[subagent].allowed_tools');
    expect(container.querySelector('table')).toBeNull();
    // Built-in tools allow by default and carry no control; the opt-ins do.
    expect(row('Bash')!.textContent).toContain('Allowed');
    expect(row('Bash')!.querySelector('input')).toBeNull();
    expect(row('BoardRead')!.querySelector('input[data-server-allow="BoardRead"]')).not.toBeNull();
    expect(row('BoardRead')!.textContent).toContain('Blocked');
    // Asking the user is an opt-in now, not a main-only tool.
    expect(row('AskUserQuestion')!.textContent).toContain('Blocked');
    expect(row('AskUserQuestion')!.querySelector('input[data-server-allow="AskUserQuestion"]')).not.toBeNull();
    // MemoryWrite stays out of reach whatever either object writes.
    expect(row('MemoryWrite')!.textContent).toContain('Not editable');
    // MCP tools are in the same list and searchable, and are not the rule's business.
    expect(rowNames()).toContain('mcp__fixture-fs__read_file');
    expect(row('mcp__fixture-fs__read_file')!.textContent).toContain('read_file');
  });

  it('finds a tool by name and shows its purpose and object state in the detail pane', async () => {
    await render();
    await type(container.querySelector<HTMLInputElement>('[data-subagent-tools-search]')!, 'bash');
    expect(rowNames()).toEqual(['Bash']);
    expect(container.querySelector('[data-subagent-tools-count]')?.textContent).toContain('1 of 12');
    expect(row('Bash')!.textContent).toContain('Run a shell command.');
    await openTool('Bash');
    expect(detail()!.textContent).toContain('Run a shell command.');
    expect(detail()!.textContent).toContain('Default rule');
    expect(detail()!.textContent).toContain('The default rule allows Bash for every subagent.');
  });

  it('saves a board opt-in through the config patch and keeps the echoed value', async () => {
    await render();
    await act(async () => { row('BoardRead')!.querySelector<HTMLInputElement>('input')!.click(); });
    expect(footer()).not.toBeNull();
    await save();
    expect(client.patchConfig).toHaveBeenCalledWith({ subagent: { allowed_tools: ['BoardRead'] } });
    expect(row('BoardRead')!.querySelector<HTMLInputElement>('input')!.checked).toBe(true);
    expect(container.querySelector('[data-saved-tick]')).not.toBeNull();
    expect(footer()!.disabled).toBe(true);
  });

  it('resets the rule to no extra allows as a draft that still needs saving', async () => {
    client.getConfig.mockResolvedValue({ subagent: { allowedTools: ['BoardRead', 'BoardWrite'] } });
    await render();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-subagent-tools-reset]')!.click(); });
    await settle();
    expect(row('BoardRead')!.textContent).toContain('Blocked');
    await save();
    expect(client.patchConfig).toHaveBeenCalledWith({ subagent: { allowed_tools: [] } });
  });

  it('keeps a failed rule save as a draft and lets the save be retried', async () => {
    client.patchConfig.mockRejectedValueOnce(new Error('fixture save failure'));
    await render();
    await act(async () => { row('BoardWrite')!.querySelector<HTMLInputElement>('input')!.click(); });
    await save();
    expect(container.textContent).toContain('fixture save failure');
    expect(row('BoardWrite')!.querySelector<HTMLInputElement>('input')!.checked).toBe(true);
    expect(footer()!.disabled).toBe(false);
    await save();
    expect(client.patchConfig).toHaveBeenLastCalledWith({ subagent: { allowed_tools: ['BoardWrite'] } });
    expect(container.textContent).not.toContain('fixture save failure');
  });

  it('never opens a main-agent-only tool through the rule or an agent list', async () => {
    client.getConfig.mockResolvedValue({ subagent: { allowedTools: ['MemoryWrite'] } });
    await render();
    expect(row('MemoryWrite')!.textContent).toContain('Not editable');
    expect(row('MemoryWrite')!.querySelector('input')).toBeNull();
    await openTool('MemoryWrite');
    expect(detail()!.textContent).toContain('main-agent only');
    expect(detail()!.textContent).toContain('neither the default rule nor an agent tool list');
  });

  it('reads the merged Cron and Goal registrations through the shared alias table', async () => {
    client.listTools.mockResolvedValue({ tools: [...CATALOG,
      TOOL('Cron', 'builtin', 'Schedule a prompt.'),
      TOOL('Goal', 'builtin', 'Set a goal.'),
      TOOL('CronDelete', 'builtin', 'Delete a scheduled prompt.'),
    ]});
    await render();
    // Cron is an opt-in whose actions it covers; a goal stays main-only, and
    // the shared alias table decides both from the older names.
    for (const name of ['Cron', 'CronDelete']) {
      expect(row(name)!.textContent).toContain('Blocked');
      expect(row(name)!.querySelector('input[data-server-allow]')).not.toBeNull();
    }
    expect(row('Goal')!.textContent).toContain('Not editable');
    expect(row('Goal')!.querySelector('input')).toBeNull();
    expect(rowAction('Goal', 'deny')).toBeNull();
    await openTool('Goal');
    expect(detail()!.textContent).toContain('main-agent only');
    // A built-in that is not an alias is untouched by that rule.
    expect(row('Bash')!.textContent).not.toContain('Not editable');
    expect(row('Bash')!.textContent).toContain('Allowed');
  });

  it('reads a profile as its own lists, inheriting everything it does not mention', async () => {
    await render();
    await selectObject('explore');
    expect(container.querySelector('[data-subagent-tools-object-source]')?.textContent).toContain('/fixture/agents/explore.md');
    expect(container.querySelector('[data-subagent-tools-object-source]')?.textContent).toContain('ws-fixture');
    expect(row('Bash')!.textContent).toContain('Allowed');
    expect(rowReason('Bash')).toBe('Named in this agent’s tools');
    expect(row('Write')!.textContent).toContain('Blocked');
    expect(rowReason('Write')).toBe('Denied by this agent');
    // A tool the allowlist leaves out is blocked for this agent, not inherited.
    expect(row('Read')!.textContent).toContain('Blocked');
    expect(rowReason('Read')).toBe('Not in this agent’s tools list');
    expect(row('BoardWrite')!.textContent).toContain('Blocked');
    // This profile's own list leaves it out, so the subagent default MemoryRead
    // is not selected for it either.
    expect(row('MemoryRead')!.textContent).toContain('Blocked');
    expect(rowReason('MemoryRead')).toBe('Not in this agent’s tools list');
    expect(row('ThreadRead')!.textContent).toContain('Blocked');
    expect(row('ThreadSend')!.textContent).toContain('Not editable');
    expect(rowAction('Write', 'editor')).not.toBeNull();
    expect(rowAction('Bash', 'deny')).not.toBeNull();
    // Nothing is previewed as "what the agent can call": the object detail shows
    // the two lists as written, plus the way to the session's own agent panel.
    const profileDetail = () => container.querySelector<HTMLElement>('[data-subagent-tools-profile-detail="explore"]');
    expect(profileDetail()!.textContent).toContain('tools');
    expect(profileDetail()!.textContent).toContain('Bash, BoardRead');
    expect(profileDetail()!.textContent).toContain('disallowedTools');
    expect(profileDetail()!.textContent).toContain('Write');
    expect(profileDetail()!.textContent).toContain('shows configuration');
    expect(profileDetail()!.querySelector('[data-subagent-tools-edit-lists]')).not.toBeNull();
    expect(profileDetail()!.querySelector('[data-subagent-tools-new-session]')).not.toBeNull();
    // An agent that declares no lists inherits the rule for every tool.
    await selectObject('general');
    expect(row('Bash')!.textContent).toContain('Inherited');
    expect(rowReason('Bash')).toBe('Follows the default rule: Allowed');
    expect(row('ThreadRead')!.textContent).toContain('Blocked');
    expect(rowReason('ThreadRead')).toBe('Needs an explicit allow');
  });

  it('saves a profile deny inline and re-reads the stored file', async () => {
    profileStore([general, explore]);
    await render();
    await selectObject('explore');
    await act(async () => { rowAction('Bash', 'deny')!.click(); });
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('explore', {
      scope: 'user',
      workspace_id: 'ws-fixture',
      source_file: '/fixture/agents/explore.md',
      tools: undefined,
      disallowed_tools: ['Write', 'Bash'],
    });
    expect(client.listNamedAgentProfiles).toHaveBeenCalledWith({ workspace_id: 'ws-fixture' });
    // The row state comes from the reloaded catalog, not from the PATCH echo.
    expect(row('Bash')!.textContent).toContain('Blocked');
    expect(rowReason('Bash')).toBe('Denied by this agent');
    expect(container.querySelector('[data-saved-tick]')).not.toBeNull();
    // ...and the same reload is what the card keeps showing after the write.
    expect(footer()!.disabled).toBe(true);
  });

  it('removes a deny through the inline allow action', async () => {
    profileStore([general, { ...explore, disallowed_tools: ['Bash'] }]);
    await render();
    await selectObject('explore');
    expect(row('Bash')!.textContent).toContain('Blocked');
    await act(async () => { rowAction('Bash', 'allow')!.click(); });
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('explore', {
      scope: 'user',
      workspace_id: 'ws-fixture',
      source_file: '/fixture/agents/explore.md',
      tools: undefined,
      disallowed_tools: [],
    });
    expect(row('Bash')!.textContent).toContain('Allowed');
    expect(rowReason('Bash')).toBe('Named in this agent’s tools');
  });

  it('offers the inline allow only when dropping that exact entry really lifts the denial', async () => {
    // One exact deny entry: removing it does unblock the tool, so the row can offer it.
    client.listNamedAgentProfiles.mockResolvedValue(catalog([general, { ...explore, disallowed_tools: ['Write', 'Bash'] }]));
    await render();
    await selectObject('explore');
    expect(row('Bash')!.textContent).toContain('Blocked');
    expect(rowAction('Bash', 'allow')).not.toBeNull();
    expect(rowAction('Bash', 'editor')).toBeNull();

    // The exact entry next to the older names that mean the same tool (a
    // non-built-in registration of an aliased name): the shared matcher still
    // denies it, so the change belongs in the tool lists.
    client.listTools.mockResolvedValue({ tools: [...CATALOG, TOOL('Cron', 'plugin', 'Schedule a prompt.')] });
    client.listNamedAgentProfiles.mockResolvedValue(catalog([general, {
      ...explore, tools: ['Bash', 'Cron'], disallowed_tools: ['Cron', 'CronCreate', 'CronList', 'CronDelete'],
    }]));
    queries.clear();
    await render();
    await selectObject('explore');
    expect(row('Cron')!.textContent).toContain('Blocked');
    expect(rowAction('Cron', 'allow')).toBeNull();
    expect(rowAction('Cron', 'editor')).not.toBeNull();

    // The exact entry next to an MCP pattern that covers it: same answer.
    client.listTools.mockResolvedValue({ tools: CATALOG });
    client.listNamedAgentProfiles.mockResolvedValue(catalog([general, {
      ...explore, tools: ['Bash', 'mcp__fixture-fs__read_file'], disallowed_tools: ['mcp__fixture-fs__*', 'mcp__fixture-fs__read_file'],
    }]));
    queries.clear();
    await render();
    await selectObject('explore');
    expect(rowAction('mcp__fixture-fs__read_file', 'allow')).toBeNull();
    expect(rowAction('mcp__fixture-fs__read_file', 'editor')).not.toBeNull();

    // An exact deny entry that the allowlist would keep blocking anyway is not a toggle either.
    client.listNamedAgentProfiles.mockResolvedValue(catalog([general, { ...explore, tools: ['Bash'], disallowed_tools: ['Write'] }]));
    queries.clear();
    await render();
    await selectObject('explore');
    expect(row('Write')!.textContent).toContain('Blocked');
    expect(rowAction('Write', 'allow')).toBeNull();
    expect(rowAction('Write', 'editor')).not.toBeNull();
  });

  it('keeps a failed profile save as a draft', async () => {
    profileStore([general, explore]);
    client.updateNamedAgentProfile.mockRejectedValue(new Error('fixture profile save failure'));
    await render();
    await selectObject('explore');
    await act(async () => { rowAction('Bash', 'deny')!.click(); });
    await save();
    expect(container.textContent).toContain('fixture profile save failure');
    expect(row('Bash')!.textContent).toContain('Blocked');
    expect(footer()).not.toBeNull();
    expect(footer()!.disabled).toBe(false);
  });

  it('shows an external executor as the backend describes it instead of native access', async () => {
    const external: NamedAgentProfile = {
      ...explore, name: 'grokbot', executor: 'external-example',
      executor_fields: { tools: { state: 'ignored', reason: 'The executor decides its own tools.' } },
    };
    client.listNamedAgentProfiles.mockResolvedValue(catalog([general, external]));
    await render();
    await selectObject('grokbot');
    expect(row('Bash')!.textContent).toContain('Not editable');
    expect(rowReason('Bash')).toBe('Decided by the executor');
    expect(row('Bash')!.querySelector('button[data-tool-allow], button[data-tool-deny], button[data-tool-editor]')).toBeNull();
    const profileDetail = container.querySelector<HTMLElement>('[data-subagent-tools-profile-detail="grokbot"]');
    expect(profileDetail!.textContent).toContain('The executor decides its own tools.');
    expect(profileDetail!.textContent).toContain('does not declare whether it uses this list');
    await openTool('Bash');
    expect(detail()!.textContent).toContain('external-example');
    expect(detail()!.textContent).toContain('The executor decides its own tools.');
    expect(detail()!.querySelector('[data-tool-detail-allow], [data-tool-detail-deny]')).toBeNull();
  });

  it('offers the existing profile editor for a writable agent and no write path for a built-in', async () => {
    await render();
    await selectObject('explore');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-subagent-tools-edit-lists]')!.click(); });
    expect(editorProps.profiles).toContain('explore');
    await selectObject('general');
    expect(container.querySelector('[data-subagent-tools-edit-lists]')).toBeNull();
    expect(row('Bash')!.querySelector('button[data-tool-allow], button[data-tool-deny]')).toBeNull();
    expect(container.textContent).toContain('no writable profile file');
  });

  it('never presents a globally denied tool as available to the agent that lists it', async () => {
    // The catalog's `active` flag is the calling session's own availability, so
    // a globally denied tool never turns a configuration row into "usable now".
    client.listTools.mockResolvedValue({ tools: CATALOG.map((tool) => tool.name === 'Bash' ? { ...tool, active: false } : tool) });
    client.getConfig.mockResolvedValue({ subagent: { allowedTools: ['BoardRead'] } });
    await render();
    await selectObject('general');
    expect(row('Bash')!.textContent).toContain('Inherited');
    expect(rowReason('Bash')).toBe('Follows the default rule: Allowed');
    await openTool('Bash');
    expect(detail()!.textContent).toContain('follows the default rule: Allowed');
    expect(detail()!.textContent).not.toContain('available');
    // An opt-in tool this profile does not name is still open when the server
    // rule names it: the engine reads those two grants as an alternative.
    expect(rowReason('BoardRead')).toBe('Allowed by the server rule');
    expect(row('BoardRead')!.textContent).toContain('Allowed');
    // This profile has no writable file, so it offers no control at all, and in
    // particular nothing that would claim to close the server's grant.
    expect(row('BoardRead')!.querySelector('input, button[data-tool-allow], button[data-tool-deny]')).toBeNull();
    // The rule's extra allow is a configuration row the user can change.
    await selectObject('Default rule');
    await openTool('BoardRead');
    expect(detail()!.textContent).toContain('The default rule allows BoardRead on top of the default access.');
    expect(row('BoardRead')!.querySelector<HTMLInputElement>('input')!.checked).toBe(true);
    await act(async () => { detail()!.querySelector<HTMLInputElement>('[data-tool-detail-opt-in="BoardRead"]')!.click(); });
    await settle();
    expect(row('BoardRead')!.textContent).toContain('Blocked');
    expect(row('BoardRead')!.querySelector<HTMLInputElement>('input')!.checked).toBe(false);
  });

  it('reads a one-name wildcard allowlist as unrestricted instead of blocking every tool', async () => {
    client.listNamedAgentProfiles.mockResolvedValue(catalog([general, { ...explore, name: 'starred', tools: ['*'], disallowed_tools: undefined }]));
    await render();
    await selectObject('starred');
    expect(row('Bash')!.textContent).toContain('Inherited');
    expect(rowReason('Bash')).toBe('Follows the default rule: Allowed');
    expect(rowAction('Bash', 'deny')).not.toBeNull();
    // A profile that writes no allowlist can still opt one child tool in: the
    // switch adds the name beside the wildcard instead of sending the user away.
    expect(row('ThreadRead')!.textContent).toContain('Blocked');
    expect(rowReason('ThreadRead')).toBe('Needs an explicit allow');
    expect(row('ThreadRead')!.querySelector('input[data-profile-opt-in="ThreadRead"]')).not.toBeNull();
  });

  it('writes one child opt-in beside the wildcard, and takes back only that name', async () => {
    profileStore([general, { ...explore, name: 'starred', tools: ['*'], disallowed_tools: undefined }]);
    await render();
    await selectObject('starred');
    // Turning on one opt-in must not take the ordinary tools with it.
    await act(async () => { row('ThreadRead')!.querySelector<HTMLInputElement>('input')!.click(); });
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('starred', {
      scope: 'user',
      workspace_id: 'ws-fixture',
      source_file: '/fixture/agents/explore.md',
      tools: ['*', 'ThreadRead'],
      disallowed_tools: undefined,
    });
    expect(row('Bash')!.textContent).toContain('Inherited');
    expect(row('ThreadRead')!.textContent).toContain('Allowed');
    expect(row('ThreadRead')!.querySelector<HTMLInputElement>('input')!.checked).toBe(true);
    // The default rule still decides the other opt-ins: naming one tool opens
    // that tool, never the rest.
    expect(row('BoardRead')!.textContent).toContain('Blocked');
    expect(row('ThreadRead')!.querySelector<HTMLInputElement>('input[data-profile-opt-in]')).not.toBeNull();
    // A main-only tool is unaffected by the same switch.
    expect(row('ThreadSend')!.textContent).toContain('Not editable');

    // Turning it off again removes that one name and leaves the wildcard.
    await act(async () => { row('ThreadRead')!.querySelector<HTMLInputElement>('input')!.click(); });
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenLastCalledWith('starred', {
      scope: 'user',
      workspace_id: 'ws-fixture',
      source_file: '/fixture/agents/explore.md',
      tools: ['*'],
      disallowed_tools: undefined,
    });
    expect(row('ThreadRead')!.textContent).toContain('Blocked');
    expect(row('Bash')!.textContent).toContain('Inherited');
  });

  it('keeps a deny and a child opt-in as two separate controls on one row', async () => {
    client.listNamedAgentProfiles.mockResolvedValue(catalog([general, {
      ...explore, tools: ['*'], disallowed_tools: ['ThreadWait', 'Bash'],
    }]));
    await render();
    await selectObject('explore');
    // Deny first: the deny wins and the row offers the allow that lifts it.
    expect(row('ThreadWait')!.textContent).toContain('Blocked');
    expect(rowReason('ThreadWait')).toBe('Denied by this agent');
    expect(rowAction('ThreadWait', 'allow')).not.toBeNull();
    expect(row('ThreadWait')!.querySelector('input[data-profile-opt-in]')).toBeNull();
    await act(async () => { rowAction('ThreadWait', 'allow')!.click(); });
    await save();
    // Lifting it names the tool rather than pretending the deny was the only
    // thing in the way, and leaves the unrelated deny alone.
    expect(client.updateNamedAgentProfile).toHaveBeenLastCalledWith('explore', {
      scope: 'user',
      workspace_id: 'ws-fixture',
      source_file: '/fixture/agents/explore.md',
      tools: ['*', 'ThreadWait'],
      disallowed_tools: ['Bash'],
    });
    expect(row('ThreadWait')!.textContent).toContain('Allowed');
    expect(row('Bash')!.textContent).toContain('Blocked');
    expect(rowReason('Bash')).toBe('Denied by this agent');
  });

  it('reaches the opt-in and its scope note from the detail pane alone', async () => {
    client.listNamedAgentProfiles.mockResolvedValue(catalog([general, { ...explore, name: 'starred', tools: ['*'], disallowed_tools: undefined }]));
    await render();
    await selectObject('starred');
    await openTool('ThreadRead');
    const toggle = detail()!.querySelector<HTMLInputElement>('[data-tool-detail-opt-in="ThreadRead"]')!;
    expect(toggle.checked).toBe(false);
    // The main conversation is not limited by this switch, and the copy says so
    // where the decision is made rather than in a separate panel.
    expect(detail()!.textContent).toContain('only decides whether subagents of this profile may use the tool');
    expect(detail()!.textContent).toContain('A main conversation is not limited by it');
    await act(async () => { toggle.click(); });
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenLastCalledWith('starred', expect.objectContaining({
      tools: ['*', 'ThreadRead'],
    }));
  });

  it('adds the wildcard when a profile that writes no list at all opts one tool in', async () => {
    // The common case: a profile with no `tools` field. Writing the bare name
    // would silently restrict every other tool, so the switch must write the
    // name beside the wildcard instead.
    profileStore([general, { ...explore, name: 'plain', tools: undefined, disallowed_tools: ['Write'] }]);
    await render();
    await selectObject('plain');
    expect(row('Bash')!.textContent).toContain('Inherited');
    expect(row('ThreadRead')!.textContent).toContain('Blocked');
    await act(async () => { row('ThreadRead')!.querySelector<HTMLInputElement>('input[data-profile-opt-in]')!.click(); });
    expect(footer()!.disabled).toBe(false);
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenLastCalledWith('plain', {
      scope: 'user',
      workspace_id: 'ws-fixture',
      source_file: '/fixture/agents/explore.md',
      tools: ['*', 'ThreadRead'],
      disallowed_tools: undefined,
    });
    // Every ordinary tool is still available; only the named opt-in opened.
    expect(row('Bash')!.textContent).toContain('Inherited');
    expect(row('Read')!.textContent).toContain('Inherited');
    expect(row('ThreadRead')!.textContent).toContain('Allowed');
    expect(row('BoardRead')!.textContent).toContain('Blocked');
    expect(row('Write')!.textContent).toContain('Blocked');
  });

  it('reads a server-allowed opt-in as open even when this profile leaves it out', async () => {
    // The engine opens an opt-in tool when the server rule names it OR this
    // profile's own tools list names it. A profile that writes none still gets
    // the server's grant, and this object must not offer to take it away.
    client.listTools.mockResolvedValue({ tools: [...CATALOG, TOOL('Cron', 'builtin', 'Schedule a prompt.')] });
    client.getConfig.mockResolvedValue({ subagent: { allowedTools: ['BoardRead', 'Cron'] } });
    client.listNamedAgentProfiles.mockResolvedValue(catalog([general, {
      ...explore, name: 'starred', tools: ['*'], disallowed_tools: undefined,
    }]));
    await render();
    await selectObject('starred');
    expect(row('BoardRead')!.textContent).toContain('Allowed');
    expect(rowReason('BoardRead')).toBe('Allowed by the server rule');
    // The switch is absent: ticking it would add a name the server grant does
    // not need, and unticking it would change nothing.
    expect(row('BoardRead')!.querySelector('input')).toBeNull();
    expect(rowAction('BoardRead', 'deny')).toBeNull();
    await openTool('BoardRead');
    // The detail says the server rule is the reason, not this profile.
    expect(detail()!.textContent).toContain('The default rule allows BoardRead on top of the default access.');
    // Cron is named by the server under its merged name, so the row is open and
    // offers no switch either.
    expect(row('Cron')!.textContent).toContain('Allowed');
    // Neither object names ThreadRead, so this is the case the switch can open.
    expect(row('ThreadRead')!.textContent).toContain('Blocked');
    expect(row('ThreadRead')!.querySelector('input[data-profile-opt-in="ThreadRead"]')).not.toBeNull();
  });

  it('does not let a repeated opt-in delete the name it just granted', async () => {
    profileStore([general, { ...explore, name: 'starred', tools: ['*'], disallowed_tools: undefined }]);
    await render();
    await selectObject('starred');
    const toggle = () => row('ThreadRead')!.querySelector<HTMLInputElement>('input[data-profile-opt-in]')!;
    await act(async () => { toggle().click(); });
    expect(footer()!.disabled).toBe(false);
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenLastCalledWith('starred', expect.objectContaining({
      tools: ['*', 'ThreadRead'],
    }));
    // The row is now open, so the switch is a checked box: clicking it again is
    // an "off", not a second "on". Turning it off takes the grant back and
    // leaves the wildcard, and a further "on" writes it again rather than
    // deleting the entry the first "on" added.
    expect(toggle().checked).toBe(true);
    await act(async () => { toggle().click(); });
    expect(row('ThreadRead')!.textContent).toContain('Blocked');
    expect(toggle().checked).toBe(false);
    await act(async () => { toggle().click(); });
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenLastCalledWith('starred', expect.objectContaining({
      tools: ['*', 'ThreadRead'],
    }));
    expect(row('ThreadRead')!.textContent).toContain('Allowed');
  });

  it('takes back an opt-in written under an older name of the same tool', async () => {
    // `Cron` is the merged registration; `CronList` is one action under it. A
    // profile that names only the action has granted that action, and the row
    // must be able to take it back rather than leave a grant in place.
    client.listTools.mockResolvedValue({ tools: [...CATALOG, TOOL('Cron', 'builtin', 'Schedule a prompt.')] });
    client.listNamedAgentProfiles.mockResolvedValue(catalog([general, {
      ...explore, name: 'cronic', tools: ['*', 'CronList'], disallowed_tools: undefined,
    }]));
    await render();
    await selectObject('cronic');
    // The shared matcher reads the action as the tool, so the row is open.
    expect(row('Cron')!.textContent).toContain('Allowed');
    expect(rowReason('Cron')).toBe('Named in this agent’s tools');
    const toggle = row('Cron')!.querySelector<HTMLInputElement>('input[data-profile-opt-in="Cron"]');
    if (toggle !== null) {
      expect(toggle.checked).toBe(true);
      await act(async () => { toggle.click(); });
      await save();
      // The action's own grant goes, and nothing else is touched.
      expect(client.updateNamedAgentProfile).toHaveBeenLastCalledWith('cronic', expect.objectContaining({
        tools: ['*'],
      }));
      expect(row('Cron')!.textContent).toContain('Blocked');
    }
  });

  it('does not let one Cron row take away a sibling action it never granted', async () => {
    // The reverse guard: an entry under a different name of the same tool is
    // another grant, so the write leaves it and the row still reads open.
    client.listTools.mockResolvedValue({ tools: [...CATALOG, TOOL('Cron', 'builtin', 'Schedule a prompt.')] });
    client.listNamedAgentProfiles.mockResolvedValue(catalog([general, {
      ...explore, name: 'cronic', tools: ['CronList'], disallowed_tools: undefined,
    }]));
    await render();
    await selectObject('cronic');
    // A finite list selects only what it names; the opt-in is open for it.
    expect(row('Cron')!.textContent).toContain('Allowed');
    expect(row('Read')!.textContent).toContain('Blocked');
  });

  it('keeps a profile denial ahead of a server opt-in', async () => {
    client.getConfig.mockResolvedValue({ subagent: { allowedTools: ['BoardRead'] } });
    client.listNamedAgentProfiles.mockResolvedValue(catalog([general, {
      ...explore, name: 'starred', tools: ['*'], disallowed_tools: ['BoardRead'],
    }]));
    await render();
    await selectObject('starred');
    // Both objects name the tool, and the profile's own deny still wins.
    expect(row('BoardRead')!.textContent).toContain('Blocked');
    expect(rowReason('BoardRead')).toBe('Denied by this agent');
    expect(row('BoardRead')!.querySelector('input[data-profile-opt-in]')).toBeNull();
    expect(rowAction('BoardRead', 'allow')).not.toBeNull();
  });

  it('reads a finite list as a filter, so a named opt-in the list omits is still blocked', async () => {
    // The engine requires both: an opt-in grant and membership in the profile's
    // own list. `tools: ['Read']` leaves this tool out, so the server grant
    // cannot open it for this profile, and the row must not say it can.
    client.getConfig.mockResolvedValue({ subagent: { allowedTools: ['BoardRead'] } });
    client.listNamedAgentProfiles.mockResolvedValue(catalog([general, {
      ...explore, tools: ['Read'], disallowed_tools: undefined,
    }]));
    await render();
    await selectObject('explore');
    expect(row('BoardRead')!.textContent).toContain('Blocked');
    expect(rowReason('BoardRead')).toBe('Not in this agent’s tools list');
    expect(row('BoardRead')!.querySelector('input[data-profile-opt-in]')).toBeNull();
    // The switch it can honestly offer is the one that adds the tool to the list.
    expect(rowAction('BoardRead', 'allow')).not.toBeNull();
    expect(row('Read')!.textContent).toContain('Allowed');

    // The same server grant on a profile that restricts nothing is open, which
    // is the case a name beside the wildcard writes.
    client.listNamedAgentProfiles.mockResolvedValue(catalog([general, {
      ...explore, name: 'starred', tools: ['*'], disallowed_tools: undefined,
    }]));
    queries.clear();
    await render();
    await selectObject('starred');
    expect(row('BoardRead')!.textContent).toContain('Allowed');
    expect(rowReason('BoardRead')).toBe('Allowed by the server rule');
    expect(row('Read')!.textContent).toContain('Inherited');
  });

  it('reads a server name of an older action as the merged tool it covers', async () => {
    // The engine matches a `CronList` entry to the merged `Cron` registration;
    // a plain membership test would report it closed while the engine has it
    // open, on the default rule and on a profile alike.
    client.listTools.mockResolvedValue({ tools: [...CATALOG, TOOL('Cron', 'builtin', 'Schedule a prompt.')] });
    client.getConfig.mockResolvedValue({ subagent: { allowedTools: ['CronList'] } });
    client.listNamedAgentProfiles.mockResolvedValue(catalog([general, {
      ...explore, name: 'starred', tools: ['*'], disallowed_tools: undefined,
    }]));
    await render();
    // The default-rule object offers the switch and reads it as on.
    expect(row('Cron')!.textContent).toContain('Allowed');
    expect(row('Cron')!.querySelector<HTMLInputElement>('input[data-server-allow="Cron"]')!.checked).toBe(true);
    // The profile object inherits the same open state, and the server toggle
    // that turns it off writes the exact stored name, not the merged one.
    await selectObject('starred');
    expect(row('Cron')!.textContent).toContain('Allowed');
    expect(rowReason('Cron')).toBe('Allowed by the server rule');
    expect(row('Cron')!.querySelector('input[data-profile-opt-in]')).toBeNull();
    await selectObject('Default rule');
    await act(async () => { row('Cron')!.querySelector<HTMLInputElement>('input[data-server-allow="Cron"]')!.click(); });
    await save();
    expect(client.patchConfig).toHaveBeenLastCalledWith({ subagent: { allowed_tools: [] } });
  });

  it('keeps a restricted list finite: an opted-in tool is still selected by that list', async () => {
    // A profile that restricts its tools has no wildcard to add to: the name
    // joins its own list, and the list still excludes everything else.
    client.listNamedAgentProfiles.mockResolvedValue(catalog([general, { ...explore, tools: ['Bash', 'BoardRead', 'ThreadRead'], disallowed_tools: [] }]));
    await render();
    await selectObject('explore');
    expect(row('ThreadRead')!.textContent).toContain('Allowed');
    expect(row('ThreadRead')!.querySelector<HTMLInputElement>('input[data-profile-opt-in="ThreadRead"]')!.checked).toBe(true);
    // Left out of the list, so not selected, and therefore still not an opt-in.
    expect(row('Write')!.textContent).toContain('Blocked');
    expect(rowReason('Write')).toBe('Not in this agent’s tools list');
    expect(rowAction('Write', 'allow')).not.toBeNull();
    // Naming the merged name of one tool does not need a second entry for it.
    await act(async () => { row('BoardRead')!.querySelector<HTMLInputElement>('input[data-profile-opt-in]')!.click(); });
    expect(footer()!.disabled).toBe(false);
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenLastCalledWith('explore', {
      scope: 'user',
      workspace_id: 'ws-fixture',
      source_file: '/fixture/agents/explore.md',
      tools: ['Bash', 'ThreadRead'],
      disallowed_tools: undefined,
    });
  });

  it('keeps every profile identity as its own object, including same-named files', async () => {
    const builtinExplore: NamedAgentProfile = { ...general, name: 'explore', description: 'Read-only built-in explorer.' };
    client.listNamedAgentProfiles.mockResolvedValue(catalog([builtinExplore, { ...explore, override: true }]));
    await render();
    await act(async () => { container.querySelector<HTMLButtonElement>('#subagent-tools-object')!.click(); });
    const titles = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .map((candidate) => candidate.getAttribute('title') ?? '');
    expect(titles.filter((title) => title.startsWith('explore · '))).toHaveLength(2);
    await act(async () => { container.querySelectorAll<HTMLButtonElement>('[role="option"]')[0]!.click(); });
    await settle();
    await selectObject('explore', 'explore.md');
    expect(row('Bash')!.textContent).toContain('Allowed');
    expect(container.querySelector('[data-subagent-tools-edit-lists]')).not.toBeNull();
    // The built-in row is its own object: its own empty lists decide, and it has no editor.
    await selectObject('explore', 'built-in');
    expect(row('Bash')!.textContent).toContain('Inherited');
    expect(container.querySelector('[data-subagent-tools-edit-lists]')).toBeNull();
  });

  it('reads an MCP wildcard list with the engine matcher', async () => {
    client.listTools.mockResolvedValue({ tools: CATALOG });
    client.listNamedAgentProfiles.mockResolvedValue(catalog([general, { ...explore, tools: ['Bash', 'mcp__fixture-fs__*'], disallowed_tools: [] }]));
    await render();
    await selectObject('explore');
    // A wildcard allow covers the concrete registered tool...
    expect(row('mcp__fixture-fs__read_file')!.textContent).toContain('Allowed');
    expect(rowReason('mcp__fixture-fs__read_file')).toBe('Covered by one list entry that also matches other tools');
    expect(rowAction('mcp__fixture-fs__read_file', 'deny')).not.toBeNull();
    // ...while a wildcard deny takes it back even though the tool is named explicitly.
    client.listNamedAgentProfiles.mockResolvedValue(catalog([general, {
      ...explore, tools: ['Bash', 'mcp__fixture-fs__read_file'], disallowed_tools: ['mcp__fixture-fs__*'],
    }]));
    queries.clear();
    await render();
    await selectObject('explore');
    expect(row('mcp__fixture-fs__read_file')!.textContent).toContain('Blocked');
    expect(rowReason('mcp__fixture-fs__read_file')).toBe('Denied by this agent');
    // Deleting a pattern would unlock other tools, so that row opens the lists instead.
    expect(rowAction('mcp__fixture-fs__read_file', 'editor')).not.toBeNull();
    expect(rowAction('mcp__fixture-fs__read_file', 'allow')).toBeNull();
  });

  it('names the selected object by its profile name instead of the internal identity key', async () => {
    await render();
    await selectObject('explore');
    await openTool('Bash');
    const state = container.querySelector<HTMLElement>('[data-tool-state]');
    // The name the person picked, not the name+file+workspace key that selects
    // and saves the object behind it.
    expect(state!.textContent).toBe('explore · Allowed');
    expect(state!.textContent).not.toContain('/fixture/agents/explore.md');
    // The file and workspace stay readable where the object is described.
    const source = container.querySelector<HTMLElement>('[data-subagent-tools-object-source]');
    expect(source!.textContent).toContain('/fixture/agents/explore.md');
    expect(source!.textContent).toContain('ws-fixture');
  });

  it('asks before a pending draft is replaced, and keeps it when the user cancels', async () => {
    let asked: string | undefined;
    let confirm: (() => void) | undefined;
    guardState.value = { confirmDiscard: (id, action) => { asked = id; confirm = action; } };
    await render();
    await act(async () => { row('BoardWrite')!.querySelector<HTMLInputElement>('input')!.click(); });
    await selectObject('explore');
    // Cancel: the object and the draft both stay, and nothing was written.
    expect(asked).toBe('subagent-tool-draft');
    expect(container.querySelector<HTMLElement>('[data-subagent-tools-object]')?.dataset['subagentToolsObject']).toBe('__default__');
    expect(footer()).not.toBeNull();
    expect(container.textContent).toContain('Unsaved changes');
    expect(container.querySelector('[data-subagent-tools-profile-detail="explore"]')).toBeNull();
    expect(client.patchConfig).not.toHaveBeenCalled();
    // Confirm: the switch happens and the stale draft is gone.
    await act(async () => { confirm!(); });
    await settle();
    expect(container.querySelector<HTMLElement>('[data-subagent-tools-object]')?.dataset['subagentToolsObject']).toContain('explore');
    expect(container.querySelector('[data-settings-draft="subagent-tool-draft"]')).toBeNull();
  });

  it('switches objects without asking when nothing is pending', async () => {
    let asked = 0;
    guardState.value = { confirmDiscard: () => { asked += 1; } };
    await render();
    await selectObject('explore');
    expect(asked).toBe(0);
    expect(container.querySelector<HTMLElement>('[data-subagent-tools-object]')?.dataset['subagentToolsObject']).toContain('explore');
  });

  it('shows a recoverable state when the catalog is missing and can read it again', async () => {
    client.listTools.mockResolvedValue({ tools: [] });
    await render();
    expect(container.querySelector('[data-subagent-tools-empty]')?.textContent).toContain('no tool catalog');
    const before = client.listTools.mock.calls.length;
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-subagent-tools-retry]')!.click(); });
    await settle();
    expect(client.listTools.mock.calls.length).toBeGreaterThan(before);
  });

  it('reports a catalog failure with a retry instead of an empty list', async () => {
    client.listTools.mockRejectedValue(new Error('fixture catalog failure'));
    await render();
    expect(container.textContent).toContain('fixture catalog failure');
    expect(container.querySelector('[data-subagent-tools-retry]')).not.toBeNull();
  });

  it('marks the rows a pending rule draft will change, and clears the marks on save or discard', async () => {
    const pendingLine = () => container.querySelector<HTMLElement>('[data-subagent-tools-pending]');
    await render();
    expect(container.querySelector('[data-tool-changed]')).toBeNull();
    expect(pendingLine()).toBeNull();
    await act(async () => { row('BoardRead')!.querySelector<HTMLInputElement>('input')!.click(); });
    // Only the touched row is marked; its neighbour reads exactly as before.
    expect(row('BoardRead')!.querySelector('[data-tool-changed="BoardRead"]')).not.toBeNull();
    expect(row('BoardWrite')!.querySelector('[data-tool-changed]')).toBeNull();
    expect(pendingLine()!.textContent).toContain('1');
    await act(async () => { row('BoardWrite')!.querySelector<HTMLInputElement>('input')!.click(); });
    expect(pendingLine()!.textContent).toContain('2');
    // Toggling a row back to its saved state un-marks it while the draft lives.
    await act(async () => { row('BoardWrite')!.querySelector<HTMLInputElement>('input')!.click(); });
    expect(row('BoardWrite')!.querySelector('[data-tool-changed]')).toBeNull();
    expect(pendingLine()!.textContent).toContain('1');
    // A successful save makes the saved state the baseline: nothing is marked.
    await save();
    expect(client.patchConfig).toHaveBeenLastCalledWith({ subagent: { allowed_tools: ['BoardRead'] } });
    expect(container.querySelector('[data-tool-changed]')).toBeNull();
    expect(pendingLine()).toBeNull();
    // A further edit then discard drops the marks with the draft.
    await act(async () => { row('BoardRead')!.querySelector<HTMLInputElement>('input')!.click(); });
    expect(row('BoardRead')!.querySelector('[data-tool-changed="BoardRead"]')).not.toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-settings-discard="subagent-tool-draft"]')!.click(); });
    await settle();
    expect(container.querySelector('[data-tool-changed]')).toBeNull();
    expect(row('BoardRead')!.textContent).toContain('Allowed');
  });

  it('marks a first opt-in on a profile that never wrote a list', async () => {
    profileStore([general, { ...explore, name: 'plain', tools: undefined, disallowed_tools: ['Write'] }]);
    await render();
    await selectObject('plain');
    expect(container.querySelector('[data-tool-changed]')).toBeNull();
    await act(async () => { row('ThreadRead')!.querySelector<HTMLInputElement>('input[data-profile-opt-in]')!.click(); });
    expect(row('ThreadRead')!.querySelector('[data-tool-changed="ThreadRead"]')).not.toBeNull();
    expect(row('Bash')!.querySelector('[data-tool-changed]')).toBeNull();
    expect(container.querySelector('[data-subagent-tools-pending]')!.textContent).toContain('1');
    await save();
    expect(row('ThreadRead')!.textContent).toContain('Allowed');
    expect(container.querySelector('[data-tool-changed]')).toBeNull();
  });
});

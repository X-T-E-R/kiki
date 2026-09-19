// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NamedAgentProfile } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { NamedAgentProfilesCard } from './AgentsSection';
import { AgentTaskSettings } from './AgentTaskSettings';

const { client, dirtyReporter } = vi.hoisted(() => ({ dirtyReporter: vi.fn(), client: {
  listNamedAgentProfiles: vi.fn(), listWorkspaces: vi.fn(), getConfig: vi.fn(),
  patchConfig: vi.fn(), updateNamedAgentProfile: vi.fn(), getAgentCapabilities: vi.fn(),
  readHostFile: vi.fn(), meta: vi.fn(),
  listShippedAgentProfiles: vi.fn(), restoreShippedAgentProfile: vi.fn(),
} }));
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client, klient: { global: { agentPanel: { read: (query: unknown, options: { signal: AbortSignal }) => client.getAgentCapabilities(query, options.signal) } } } }) }));
vi.mock('../dirtyGuard', () => ({ useGuardedNavigate: () => vi.fn(), useDirtyReporter: dirtyReporter }));
const profile: NamedAgentProfile = {
  name: 'agent', description: 'Custom default', main: true, override: true,
  source: 'user', source_file: '/fixture/SYSTEM.md', workspace_id: 'ws-one',
  pinned_model_alias: 'fixture/model-a',
  thinking_effort: 'medium',
  service_tier: 'flex',
  subagent_policy: 'advisory',
  context_budget: 4096,
  max_completion_tokens: 512,
  request_params: { temperature: 0.2, stream: true },
  model_profiles: [{
    alias: 'fixture/model-b',
    context_budget: 2048,
    max_completion_tokens: 256,
    service_tier: 'default',
    request_params: { temperature: 0.1 },
  }],
  disabled: false, routes: [],
};
let root: Root;
let container: HTMLDivElement;
let queries: QueryClient;
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client.listNamedAgentProfiles.mockResolvedValue({ items: [profile] });
  client.listWorkspaces.mockResolvedValue({ items: [{ id: 'ws-one', root: '/fixture', name: 'Fixture', last_opened_at: '2026-09-01T00:00:00Z' }] });
  client.getConfig.mockResolvedValue({});
  client.meta.mockResolvedValue({ experimental_flags: { 'agent-profile-routes': true } });
  client.patchConfig.mockResolvedValue({ disabled_named_profiles: ['agent'] });
  client.getAgentCapabilities.mockResolvedValue({ context: 'draft', owner: { profile: 'agent' }, available: true,
    targets: [{ profile: 'directory-helper', executor: 'native', defaults_available: false }] });
  client.listShippedAgentProfiles.mockResolvedValue({ items: [] });
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); queries.clear(); container.remove(); });
async function render() {
  await act(async () => root.render(<QueryClientProvider client={queries}><I18nProvider><NamedAgentProfilesCard bucket="main" /></I18nProvider></QueryClientProvider>));
  await settle();
}
async function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
describe('default main profile settings', () => {
  it('keeps Todo as explanatory content without a toggle or configuration writes', async () => {
    await act(async () => root.render(<I18nProvider><AgentTaskSettings boardContent={<p>Real board owner slot</p>} /></I18nProvider>));
    expect(container.querySelector('#st-card-agent-todo')).not.toBeNull();
    expect(container.querySelector('#st-card-agent-todo input')).toBeNull();
    expect(container.querySelector('[data-board-settings-slot]')?.textContent).toContain('Real board owner slot');
    expect(client.patchConfig).not.toHaveBeenCalled();
    expect(client.getConfig).not.toHaveBeenCalled();
  });

  it('loads the selected workspace and shows a prominent default with directory-resolved capabilities', async () => {
    await render();
    expect(client.listNamedAgentProfiles).toHaveBeenCalledWith('ws-one');
    const row = container.querySelector('[data-default-agent="true"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('Custom default');
    await act(async () => row!.querySelector<HTMLButtonElement>('[data-agent-capabilities] button')!.click());
    await settle();
    expect(client.getAgentCapabilities).toHaveBeenCalledWith({ workspace_id: 'ws-one', profile: 'agent' }, expect.any(AbortSignal));
    expect(row?.textContent).toContain('directory-helper');
  });

  it('shows the projected advisory profile policy and repeats it in technical details', async () => {
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    expect(row.querySelector('[data-subagent-policy="advisory"]')?.textContent).toBe('Advisory');
    expect(row.querySelector('[data-technical-subagent-policy]')?.textContent).toContain('Dispatch policy: Advisory');
  });

  it('shows Not reported when an older profile response omits the policy field', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [{ ...profile, subagent_policy: undefined }] });
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    expect(row.querySelector('[data-subagent-policy="unknown"]')?.textContent).toBe('Not reported');
    expect(row.querySelector('[data-technical-subagent-policy]')?.textContent).toContain('Dispatch policy: Not reported');
  });

  it('shows the projected strict profile policy', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [{ ...profile, subagent_policy: 'strict' }] });
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    expect(row.querySelector('[data-subagent-policy="strict"]')?.textContent).toBe('Strict');
  });

  it('shows top-level budgets, request params, and model-profile projections', async () => {
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    expect(row.textContent).toContain('Context budget: 4096');
    expect(row.textContent).toContain('Max completion tokens: 512');
    expect(row.textContent).toContain('request params: {"temperature":0.2,"stream":true}');
    expect(row.textContent).toContain('model profile: fixture/model-b');
    expect(row.textContent).toContain('Context budget: 2048');
    expect(row.textContent).toContain('Max completion tokens: 256');
    expect(row.textContent).toContain('Service tier: default');
    expect(row.textContent).toContain('request params: {"temperature":0.1}');
    expect(row.textContent).toContain('Default model thinking effort: medium');
  });

  it('shows unset profile budgets as Unspecified instead of zero', async () => {
    client.listNamedAgentProfiles.mockResolvedValueOnce({
      items: [{ ...profile, context_budget: undefined, max_completion_tokens: undefined }],
    });
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    expect(row.textContent).toContain('Context budget: Unspecified');
    expect(row.textContent).toContain('Max completion tokens: Unspecified');
    expect(row.textContent).not.toContain('Context budget: 0');
    expect(row.textContent).not.toContain('Max completion tokens: 0');
  });

  it('clears the previous profile effort when the pinned model changes', async () => {
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    const edit = [...row.querySelectorAll('button')].find((button) => button.textContent === 'Edit')!;
    await act(async () => { edit.click(); });
    // The editor is a dialog portaled to document.body, outside the row.
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Edit profile: agent');
    const effort = dialog.querySelector<HTMLSelectElement>('[data-agent-thinking-effort]')!;
    expect(effort.value).toBe('medium');
    await setInputValue(dialog.querySelector<HTMLInputElement>('[data-agent-model-alias]')!, 'fixture/model-b');
    expect(effort.value).toBe('');
  });

  it('opens the editor at the shared md width and reports unsaved edits to the dirty guard', async () => {
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    const edit = [...row.querySelectorAll('button')].find((button) => button.textContent === 'Edit')!;
    await act(async () => { edit.click(); });
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.className).toContain('max-w-[640px]');
    const guardId = 'agent-profile-editor:user:agent';
    expect(dirtyReporter).toHaveBeenLastCalledWith(guardId, false);
    const description = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(description, 'Unsaved tweak');
      description.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(dirtyReporter).toHaveBeenLastCalledWith(guardId, true);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(description, 'Custom default');
      description.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(dirtyReporter).toHaveBeenLastCalledWith(guardId, false);
  });

  it('saves the profile through the pop-up editor and closes it with a saved affirmation', async () => {
    const echo = { ...profile, description: 'Updated default', pinned_model_alias: 'fixture/model-b' };
    client.updateNamedAgentProfile.mockResolvedValue(echo);
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    const edit = [...row.querySelectorAll('button')].find((button) => button.textContent === 'Edit')!;
    await act(async () => { edit.click(); });
    const dialog = document.body.querySelector('[role="dialog"]')!;
    await setInputValue(dialog.querySelector<HTMLInputElement>('[data-agent-model-alias]')!, 'fixture/model-b');
    const description = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(description, 'Updated default');
      description.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Save')!;
    // The save invalidates the profile catalogs, so the follow-up refetch must
    // answer with the echo (a real server persists the PATCH; the mock does not).
    client.listNamedAgentProfiles.mockResolvedValue({ items: [echo] });
    await act(async () => { save.click(); });
    await settle();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('agent', expect.objectContaining({
      source_file: '/fixture/SYSTEM.md',
      workspace_id: 'ws-one',
      description: 'Updated default',
      pinned_model_alias: 'fixture/model-b',
      thinking_effort: null,
    }));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[data-default-agent="true"]')?.textContent).toContain('Updated default');
    expect(container.querySelector('[data-default-agent="true"]')?.textContent).toContain('Agent profile saved and reloaded.');
  });

  it('keeps the dialog open with the error when the profile save fails', async () => {
    client.updateNamedAgentProfile.mockRejectedValue(new Error('fixture failure'));
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    const edit = [...row.querySelectorAll('button')].find((button) => button.textContent === 'Edit')!;
    await act(async () => { edit.click(); });
    const dialog = document.body.querySelector('[role="dialog"]')!;
    // The save button stays disabled until the draft differs from the profile.
    const description = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(description, 'Fixture failure draft');
      description.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Save')!;
    await act(async () => { save.click(); });
    await settle();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[role="dialog"]')!.textContent).toContain('fixture failure');
  });

  it('uses the effective source for the default entry and does not expose capabilities on a shadowed file', async () => {
    const shadow = { ...profile, source_file: '/fixture/agents/agent.md', description: 'Shadowed file' };
    client.listNamedAgentProfiles.mockImplementation(async (query: unknown) => ({
      items: typeof query === 'object' ? [profile] : [shadow, profile],
    }));
    await render();
    expect(container.querySelectorAll('[data-default-agent="true"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-agent-capabilities]')).toHaveLength(1);
    const shadowRow = [...container.querySelectorAll('[data-agent-profile]')].find((row) => row.textContent?.includes('Shadowed file'))!;
    expect(shadowRow.querySelector<HTMLButtonElement>('[data-new-session-href]')?.disabled).toBe(true);
  });

  it('R3 keeps the effective builtin default prominent when a raw external override is rejected', async () => {
    const builtin: NamedAgentProfile = { name: 'agent', main: true, source: 'builtin', description: 'Builtin default', disabled: false, routes: [] };
    const rejected = { ...profile, source_file: '/fixture/agents/agent.md', executor: 'grok-acp' };
    client.listNamedAgentProfiles.mockImplementation(async (query: unknown) => ({
      items: typeof query === 'object' ? [builtin] : [rejected, builtin],
    }));
    await render();
    const row = container.querySelector('[data-default-agent="true"]');
    expect(row?.getAttribute('data-agent-source')).toBe('builtin');
    expect(row?.getAttribute('data-override-state')).not.toBe('overridden');
    expect(row?.querySelector<HTMLButtonElement>('[data-new-session-href]')?.disabled).toBe(false);
    await act(async () => row!.querySelector<HTMLButtonElement>('[data-agent-capabilities] button')!.click());
    await settle();
    expect(client.getAgentCapabilities).toHaveBeenCalledWith({ workspace_id: 'ws-one', profile: 'agent' }, expect.any(AbortSignal));
    const rejectedRow = container.querySelector('[data-agent-source="user"]');
    expect(rejectedRow?.querySelector('[data-agent-capabilities]')).toBeNull();
    expect(rejectedRow?.querySelector<HTMLButtonElement>('[data-new-session-href]')?.disabled).toBe(true);
    expect(rejectedRow?.textContent).not.toContain('Overrides the built-in');
  });

  it('marks a workspace profile switch as the server-wide, name-keyed switch it is', async () => {
    const workspaceProfile: NamedAgentProfile = {
      ...profile,
      name: 'ws-helper',
      source: 'workspace',
      source_file: '/fixture/.kiki/agents/ws-helper.md',
      main: true,
    };
    client.listNamedAgentProfiles.mockResolvedValue({ items: [workspaceProfile] });
    client.patchConfig.mockResolvedValue({ disabled_named_profiles: ['ws-helper'] });
    await render();
    const row = container.querySelector('[data-agent-profile="ws-helper"]')!;
    // The scope is spelled out next to the switch, not only in its tooltip.
    expect(row.querySelector('[data-toggle-scope="server"]')?.textContent).toBe(
      'Server-wide · affects every profile with this name',
    );
    expect(row.querySelector('[data-toggle-scope-hint]')?.textContent).toContain('everywhere');
    await act(async () => row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await settle();
    expect(client.patchConfig).toHaveBeenCalledWith({ disabled_named_profiles: ['ws-helper'] });
  });

  it('invalidates effective catalog caches after toggling discovery without disabling the main entry', async () => {
    queries.setQueryData(['agentProfiles', 'cwd', '/fixture', 'effective'], { items: [profile] });
    await render();
    client.listNamedAgentProfiles.mockImplementation(async (query: unknown) => ({
      items: [typeof query === 'object' ? profile : { ...profile, disabled: true }],
    }));
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await settle();
    expect(client.patchConfig).toHaveBeenCalledWith({ disabled_named_profiles: ['agent'] });
    expect(queries.getQueryState(['agentProfiles', 'cwd', '/fixture', 'effective'])?.isInvalidated).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-default-agent="true"] [data-new-session-href]')?.disabled).toBe(false);
  });

  it('pins raw edits to the displayed source and invalidates effective catalogs and capabilities', async () => {
    queries.setQueryData(['agentProfiles', 'cwd', '/fixture', 'effective'], { items: [profile] });
    queries.setQueryData(['agentCapabilities', { workspace_id: 'ws-one', profile: 'agent' }], { targets: [] });
    const rawText = '---\nname: agent\ncontext_budget: 2048\nmax_completion_tokens: 256\nrequest_params:\n  temperature: 0.1\nmodel_profiles:\n  - alias: fixture/model-b\n    context_budget: 1024\n    max_completion_tokens: 128\n---\n\nRaw body.';
    const rawEcho = {
      ...profile,
      context_budget: 2048,
      max_completion_tokens: 256,
      request_params: { temperature: 0.1 },
      model_profiles: [{ alias: 'fixture/model-b', context_budget: 1024, max_completion_tokens: 128 }],
    } satisfies NamedAgentProfile;
    client.listNamedAgentProfiles.mockResolvedValue({ items: [rawEcho] });
    client.readHostFile.mockResolvedValue(rawText);
    client.updateNamedAgentProfile.mockResolvedValue(rawEcho);
    await render();
    const button = (text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === text)!;
    await act(async () => button('View / edit raw file').click());
    await settle();
    await act(async () => button('Save raw file').click());
    await settle();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('agent', expect.objectContaining({ source_file: '/fixture/SYSTEM.md', workspace_id: 'ws-one', raw_text: rawText }));
    expect(container.querySelector('[data-default-agent="true"]')?.textContent).toContain('Context budget: 2048');
    expect(container.querySelector('[data-default-agent="true"]')?.textContent).toContain('Max completion tokens: 256');
    expect(container.querySelector('[data-default-agent="true"]')?.textContent).toContain('model profile: fixture/model-b');
    expect(queries.getQueryState(['agentProfiles', 'cwd', '/fixture', 'effective'])?.isInvalidated).toBe(true);
    expect(queries.getQueryState(['agentCapabilities', { workspace_id: 'ws-one', profile: 'agent' }])?.isInvalidated).toBe(true);
  });

  it('treats the managed built-in copy as the effective row when no workspace is selected', async () => {
    // No workspace means no `?effective=true` catalog, so the row that carries
    // the managed built-in copy is the one that runs under its own name.
    const builtinCopy: NamedAgentProfile = {
      name: 'agent', main: true, source: 'user', disabled: false, routes: [],
      source_file: '/fixture/user/agents/builtin/agent.md',
      description: 'Builtin default',
    };
    const shadowingCopy: NamedAgentProfile = {
      name: 'agent', main: true, source: 'user', disabled: false, routes: [],
      source_file: '/fixture/user/agents/agent.md',
      description: 'Unmanaged same-name copy',
    };
    client.listWorkspaces.mockResolvedValue({ items: [] });
    client.listNamedAgentProfiles.mockResolvedValue({ items: [builtinCopy, shadowingCopy] });
    client.listShippedAgentProfiles.mockResolvedValue({ items: [{
      template_id: 'agent', status: 'clean', managed: true, main: true,
      description: 'Built-in default', active_path: '/fixture/user/agents/builtin/agent.md',
    }] });
    await render();
    expect(client.listNamedAgentProfiles).toHaveBeenCalledWith();
    const rows = [...container.querySelectorAll<HTMLElement>('[data-agent-profile="agent"]')];
    expect(rows).toHaveLength(2);
    const builtinRow = rows.find((row) => row.textContent?.includes('Builtin default'))!;
    expect(builtinRow.getAttribute('data-default-agent')).toBe('true');
    expect(builtinRow.querySelector<HTMLButtonElement>('[data-new-session-href]')?.disabled).toBe(false);
    const shadowingRow = rows.find((row) => row.textContent?.includes('Unmanaged same-name copy'))!;
    expect(shadowingRow.getAttribute('data-default-agent')).toBeNull();
  });
});

/**
 * Tool-list fidelity: an absent `tools` field ("this layer does not restrict"),
 * `tools: []` ("no tool at all") and a named list are three engine states, so an
 * untouched field must never be re-serialized and a touched one must land on the
 * state the user picked.
 */
describe('profile editor tool-list fidelity', () => {
  const toolsMode = (dialog: HTMLElement) =>
    dialog.querySelector<HTMLSelectElement>('[data-tool-field-mode="tools"]')!;
  const toolsList = (dialog: HTMLElement) =>
    dialog.querySelector<HTMLTextAreaElement>('[data-tool-field-list="tools"]');
  const disallowedMode = (dialog: HTMLElement) =>
    dialog.querySelector<HTMLSelectElement>('[data-tool-field-mode="disallowedTools"]')!;
  const disallowedList = (dialog: HTMLElement) =>
    dialog.querySelector<HTMLTextAreaElement>('[data-tool-field-list="disallowedTools"]');
  const descriptionField = (dialog: HTMLElement) => dialog.querySelector<HTMLTextAreaElement>('textarea')!;

  async function openEditor(overrides: Partial<NamedAgentProfile>): Promise<HTMLElement> {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [{ ...profile, ...overrides }] });
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    const edit = [...row.querySelectorAll('button')].find((button) => button.textContent === 'Edit')!;
    await act(async () => { edit.click(); });
    return document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  }

  async function setSelect(select: HTMLSelectElement, value: string): Promise<void> {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  async function setText(
    target: HTMLTextAreaElement | HTMLInputElement,
    value: string,
  ): Promise<void> {
    await act(async () => {
      const prototype = target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!;
      setter.call(target, value);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function save(dialog: HTMLElement): Promise<Record<string, unknown>> {
    const button = [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Save')!;
    expect(button.disabled).toBe(false);
    await act(async () => { button.click(); });
    await settle();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledTimes(1);
    const [name, body] = client.updateNamedAgentProfile.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('agent');
    return body;
  }

  it('keeps an untouched `tools: []` out of the patch instead of clearing the field', async () => {
    const dialog = await openEditor({ tools: [] });
    expect([...toolsMode(dialog).options].map((option) => option.textContent)).toEqual([
      'Inherit',
      'Deny all',
      'Allow list only',
    ]);
    expect(toolsMode(dialog).value).toBe('empty');
    expect(toolsList(dialog)).toBeNull();
    await setText(descriptionField(dialog), 'Touched description');
    const body = await save(dialog);
    expect(body['description']).toBe('Touched description');
    expect(body['tools']).toBeUndefined();
    // The wire body is JSON, where an `undefined` field disappears entirely —
    // which is what keeps "deny every tool" from turning into "unrestricted".
    expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty('tools');
    expect(body['disallowed_tools']).toBeUndefined();
  });

  it('keeps an untouched named list and its text', async () => {
    const dialog = await openEditor({ tools: ['Read', 'Bash'] });
    expect(toolsMode(dialog).value).toBe('list');
    expect(toolsList(dialog)!.value).toBe('Read, Bash');
    await setText(descriptionField(dialog), 'Touched description');
    const body = await save(dialog);
    expect(body['tools']).toBeUndefined();
    expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty('tools');
  });

  it('keeps an untouched absent field absent and writes the list the user types', async () => {
    const dialog = await openEditor({ tools: undefined });
    expect(toolsMode(dialog).value).toBe('inherit');
    expect(toolsList(dialog)).toBeNull();
    await setSelect(toolsMode(dialog), 'list');
    await setText(toolsList(dialog)!, 'Read, Bash');
    await setText(descriptionField(dialog), 'Touched description');
    const body = await save(dialog);
    expect(body['tools']).toEqual(['Read', 'Bash']);
  });

  it('writes an explicit empty list when the allow list moves to the deny state', async () => {
    const dialog = await openEditor({ tools: ['Read'] });
    await setSelect(toolsMode(dialog), 'empty');
    await setText(descriptionField(dialog), 'Touched description');
    const body = await save(dialog);
    expect(body['tools']).toEqual([]);
  });

  it('clears the field when the allow list returns to inherit', async () => {
    const dialog = await openEditor({ tools: ['Read'] });
    await setSelect(toolsMode(dialog), 'inherit');
    await setText(descriptionField(dialog), 'Touched description');
    const body = await save(dialog);
    expect(body['tools']).toBeNull();
  });

  it('refuses a named-list state that names nothing until the user fills it in', async () => {
    const dialog = await openEditor({ tools: [] });
    await setSelect(toolsMode(dialog), 'list');
    await setText(descriptionField(dialog), 'Touched description');
    const button = [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Save')!;
    expect(button.disabled).toBe(true);
    expect(dialog.querySelector('[data-tool-field-error="tools"]')?.textContent).toContain(
      'Enter at least one tool name',
    );
    await setSelect(toolsMode(dialog), 'empty');
    expect(button.disabled).toBe(false);
    expect(dialog.querySelector('[data-tool-field-error="tools"]')).toBeNull();
  });

  it('tracks the disallowed list three-way as well', async () => {
    const dialog = await openEditor({ disallowed_tools: [] });
    expect([...disallowedMode(dialog).options].map((option) => option.textContent)).toEqual([
      'Inherit',
      'Do not deny any tools',
      'Deny listed tools',
    ]);
    expect(disallowedMode(dialog).value).toBe('empty');
    await setText(descriptionField(dialog), 'Touched description');
    const untouched = await save(dialog);
    expect(untouched['disallowed_tools']).toBeUndefined();
  });

  it('writes the deny list the user picks', async () => {
    const dialog = await openEditor({ disallowed_tools: ['WebSearch'] });
    expect(disallowedMode(dialog).value).toBe('list');
    expect(disallowedList(dialog)!.value).toBe('WebSearch');
    await setSelect(disallowedMode(dialog), 'empty');
    await setText(descriptionField(dialog), 'Touched description');
    const body = await save(dialog);
    expect(body['disallowed_tools']).toEqual([]);
    expect(body['tools']).toBeUndefined();
  });
});

describe('shipped (built-in) profile management', () => {
  const shippedEntry = {
    template_id: 'agent',
    status: 'custom',
    managed: true,
    main: true,
    description: 'Default main agent',
    active_path: '/fixture/SYSTEM.md',
  };

  it('marks the managed built-in copy with its status and restores it after a double confirmation', async () => {
    client.listShippedAgentProfiles.mockResolvedValue({ items: [shippedEntry] });
    client.restoreShippedAgentProfile.mockResolvedValue({ ...shippedEntry, status: 'clean' });
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    expect(row.querySelector('[data-shipped-status="custom"]')?.textContent).toBe('Built-in · modified');
    const restore = row.querySelector<HTMLButtonElement>('[data-shipped-restore="agent"]')!;
    await act(async () => { restore.click(); });
    const dialog = document.body.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Restore the original of built-in profile "agent"?');
    // The row's copy pins fixture/model-a, so the warning spells the pin out.
    expect(dialog.textContent).toContain('pins model fixture/model-a');
    expect(dialog.textContent).toContain('backed up automatically');
    const callsBefore = client.listShippedAgentProfiles.mock.calls.length;
    const confirm = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Restore original')!;
    await act(async () => { confirm.click(); });
    await settle();
    expect(client.restoreShippedAgentProfile).toHaveBeenCalledWith('agent');
    expect(client.listShippedAgentProfiles.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(row.textContent).toContain('Original restored and agent profiles reloaded.');
  });

  it('shows an unmodified built-in copy without a restore action', async () => {
    client.listShippedAgentProfiles.mockResolvedValue({ items: [{ ...shippedEntry, status: 'clean' }] });
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    expect(row.querySelector('[data-shipped-status="clean"]')?.textContent).toBe('Built-in · unmodified');
    expect(row.querySelector('[data-shipped-restore]')).toBeNull();
  });

  it('refreshes a managed copy from clean to custom immediately after editing it', async () => {
    let shippedStatus: 'clean' | 'custom' = 'clean';
    client.listShippedAgentProfiles.mockImplementation(async () => ({
      items: [{ ...shippedEntry, status: shippedStatus }],
    }));
    const echo = { ...profile, description: 'Customized managed copy' };
    client.updateNamedAgentProfile.mockResolvedValue(echo);
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    expect(row.querySelector('[data-shipped-status="clean"]')?.textContent).toBe('Built-in · unmodified');
    expect(row.querySelector('[data-shipped-restore]')).toBeNull();

    const edit = [...row.querySelectorAll('button')].find((button) => button.textContent === 'Edit')!;
    await act(async () => { edit.click(); });
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const description = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(description, 'Customized managed copy');
      description.dispatchEvent(new Event('input', { bubbles: true }));
    });
    client.listNamedAgentProfiles.mockResolvedValue({ items: [echo] });
    shippedStatus = 'custom';
    const callsBefore = client.listShippedAgentProfiles.mock.calls.length;
    const save = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Save')!;
    await act(async () => { save.click(); });
    await settle();

    expect(client.listShippedAgentProfiles.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(row.querySelector('[data-shipped-status="custom"]')?.textContent).toBe('Built-in · modified');
    expect(row.querySelector('[data-shipped-restore="agent"]')).not.toBeNull();
  });

  it('renders rows unchanged when the shipped-status endpoint does not exist', async () => {
    client.listShippedAgentProfiles.mockRejectedValue(new Error('unknown route'));
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    expect(row.textContent).toContain('Custom default');
    expect(row.querySelector('[data-shipped-status]')).toBeNull();
    expect(row.querySelector('[data-shipped-restore]')).toBeNull();
  });

  it('offers a tombstone restore row for a removed managed copy', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [] });
    client.listShippedAgentProfiles.mockResolvedValue({
      items: [{ ...shippedEntry, status: 'removed' }],
    });
    client.restoreShippedAgentProfile.mockResolvedValue({ ...shippedEntry, status: 'clean' });
    await render();
    const tombstone = container.querySelector('[data-shipped-removed="agent"]')!;
    expect(tombstone.textContent).toContain('Default main agent');
    expect(tombstone.querySelector('[data-shipped-status="removed"]')?.textContent).toBe('Built-in · removed');
    const restore = tombstone.querySelector<HTMLButtonElement>('[data-shipped-restore="agent"]')!;
    await act(async () => { restore.click(); });
    const dialog = document.body.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('recreates the original bundled with this release');
    expect(dialog.textContent).not.toContain('pins model');
    const confirm = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Restore original')!;
    await act(async () => { confirm.click(); });
    await settle();
    expect(client.restoreShippedAgentProfile).toHaveBeenCalledWith('agent');
    expect(container.querySelector('#st-card-main-agents')?.textContent).toContain('Original restored and agent profiles reloaded.');
  });
});

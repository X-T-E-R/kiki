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
} }));
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client, klient: { global: { agentPanel: { read: (query: unknown, options: { signal: AbortSignal }) => client.getAgentCapabilities(query, options.signal) } } } }) }));
vi.mock('../dirtyGuard', () => ({ useGuardedNavigate: () => vi.fn(), useDirtyReporter: dirtyReporter }));
const profile: NamedAgentProfile = {
  name: 'agent', description: 'Custom default', main: true, override: true,
  source: 'user', source_file: '/fixture/SYSTEM.md', workspace_id: 'ws-one',
  pinned_model_alias: 'fixture/model-a',
  thinking_effort: 'medium',
  service_tier: 'flex',
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
});

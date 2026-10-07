// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NamedAgentProfile } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { NamedAgentProfilesCard } from './AgentsSection';
import { openOptions, optionLabels, pickValue } from './testControls';
import { AgentTaskSettings } from './AgentTaskSettings';
import { AgentRuntimeCard } from './AgentRuntimeSettings';

const { client, dirtyReporter } = vi.hoisted(() => ({ dirtyReporter: vi.fn(), client: {
  listNamedAgentProfiles: vi.fn(), listWorkspaces: vi.fn(), getConfig: vi.fn(),
  patchConfig: vi.fn(), updateNamedAgentProfile: vi.fn(), getAgentCapabilities: vi.fn(),
  readHostFile: vi.fn(), meta: vi.fn(),
  listShippedAgentProfiles: vi.fn(), restoreShippedAgentProfile: vi.fn(), listModels: vi.fn(),
  klient: { rest: { agents: { previewModelMenu: vi.fn() } } },
} }));
vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client,
    klient: {
      global: {
        agentPanel: {
          read: (query: unknown, options: { signal: AbortSignal }) =>
            client.getAgentCapabilities(query, options.signal),
        },
      },
    },
  }),
  useOptionalConnection: () => ({ client }),
}));
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
  client.listModels.mockResolvedValue({ items: [] });
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
/** Every render goes through one router: the card reads `?workspace=`. */
async function renderAt(entry: string, node: ReactNode) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <QueryClientProvider client={queries}><I18nProvider>{node}</I18nProvider></QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

/** Renders the card at `?workspace=` so a link from a workspace page can be tested. */
async function render(bucket: 'main' | 'sub' = 'main', workspace?: string) {
  await renderAt(
    workspace === undefined ? '/' : `/?workspace=${encodeURIComponent(workspace)}`,
    <NamedAgentProfilesCard bucket={bucket} />,
  );
}

/**
 * Address moves performed while the card is already mounted, which is the case
 * a first-render-only read of `?workspace=` cannot follow: a link to another
 * workspace, and Back.
 */
function AddressDriver() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" data-drive-to="ws-three" onClick={() => { void navigate('/?workspace=ws-three'); }} />
      <button type="button" data-drive-back onClick={() => { void navigate(-1); }} />
    </>
  );
}
async function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('agent runtime identity settings', () => {
  it('saves the Kimi Code compatibility switch in the identity section', async () => {
    client.getConfig.mockResolvedValue({ identity: { advertiseAsKimiCode: false } });
    client.patchConfig.mockResolvedValue({ identity: { advertiseAsKimiCode: true } });
    await renderAt('/', <AgentRuntimeCard />);

    const card = container.querySelector('#st-card-agent-runtime')!;
    expect(card.textContent).toContain('Identify as Kimi Code to upstream services');
    await act(async () => card.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => [...card.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click());
    await settle();

    expect(client.patchConfig).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({ advertise_as_kimi_code: true }),
    }));
  });

  it('keeps the same-page profile toggle when saving an identity draft and preserves identity siblings', async () => {
    let config = { identity: { name: 'Example', slug: 'custom-slug', advertiseAsKimiCode: true }, disabled_named_profiles: ['reviewer'] };
    client.getConfig.mockImplementation(async () => config);
    client.listNamedAgentProfiles.mockImplementation(async () => ({ items: [{ ...profile, disabled: config.disabled_named_profiles.includes('agent') }] }));
    client.patchConfig.mockImplementation(async (patch) => {
      config = {
        identity: patch.identity === undefined ? config.identity : {
          name: patch.identity.name, slug: patch.identity.slug, advertiseAsKimiCode: patch.identity.advertise_as_kimi_code,
        },
        disabled_named_profiles: patch.disabled_named_profiles ?? config.disabled_named_profiles,
      };
      return config;
    });
    await renderAt('/', <><AgentRuntimeCard /><NamedAgentProfilesCard bucket="main" /></>);
    const card = container.querySelector('#st-card-agent-runtime')!;
    const identityInput = [...card.querySelectorAll('input')].find((input) => input.value === 'Example')!;
    await setInputValue(identityInput, 'Edited name');
    const checkbox = container.querySelector<HTMLInputElement>('[data-agent-profile="agent"] input[type="checkbox"]')!;
    await act(async () => { checkbox.click(); });
    await settle();
    expect(client.patchConfig).toHaveBeenNthCalledWith(1, { disabled_named_profiles: ['reviewer', 'agent'] });
    expect(checkbox.checked).toBe(false);
    expect(identityInput.value).toBe('Edited name');
    await act(async () => [...card.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click());
    await settle();
    expect(client.patchConfig).toHaveBeenNthCalledWith(2, {
      identity: { name: 'Edited name', slug: 'custom-slug', advertise_as_kimi_code: true }, replace_domains: ['identity'],
    });
    expect(config.disabled_named_profiles).toEqual(['reviewer', 'agent']);
    expect(config.identity).toEqual({ name: 'Edited name', slug: 'custom-slug', advertiseAsKimiCode: true });
    expect(checkbox.checked).toBe(false);
  });

  it('leaves the server-wide disabled-profile list to the agent list, and keeps identity saving independent of it', async () => {
    client.getConfig.mockResolvedValue({ extra_agent_dirs: ['first', 'second'], disabled_named_profiles: ['first', 'second'] });
    await renderAt('/', <AgentRuntimeCard />);
    // The agent list is the one place that writes this list, by row or by name,
    // so the identity card does not carry a second copy of it.
    expect(container.textContent).not.toContain('Disabled built-in agents');
  });

  it('keeps the extra agent directory nodes, focus and caret across typing, paste and preceding-row removal', async () => {
    const label = 'Extra agent directories';
    client.getConfig.mockResolvedValue({ extra_agent_dirs: ['first', 'second'], disabled_named_profiles: ['first', 'second'] });
    await renderAt('/', <AgentRuntimeCard />);
    const getSecond = () => container.querySelector<HTMLInputElement>(`input[aria-label="${label} 2"]`)!;
    const input = getSecond();
    input.focus();
    for (const value of ['seconds', 'seconds-more', 'pasted-value', 'pasted-value-edited']) {
      await setInputValue(input, value);
      expect(getSecond()).toBe(input);
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(value.length);
    }
    input.setSelectionRange(3, 3);
    const listEditor = input.parentElement!.parentElement!;
    await act(async () => { listEditor.querySelector<HTMLButtonElement>('button[aria-label="Remove entry 1"]')!.click(); });
    expect(container.querySelector(`input[aria-label="${label} 1"]`)).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(3);
  });

  it('refreshes the profile toggle after a row toggle writes the disabled-profile list', async () => {
    let disabled: string[] = [];
    client.getConfig.mockImplementation(async () => ({ disabled_named_profiles: disabled }));
    client.listNamedAgentProfiles.mockImplementation(async () => ({ items: [{ ...profile, disabled: disabled.includes('agent') }] }));
    client.patchConfig.mockImplementation(async (patch) => {
      disabled = patch.disabled_named_profiles;
      return { disabled_named_profiles: disabled };
    });
    queries.setQueryData(['agentProfiles', 'cwd', '/fixture', 'effective'], { items: [profile] });
    await renderAt('/', <><AgentRuntimeCard /><NamedAgentProfilesCard bucket="main" /></>);
    const checkbox = container.querySelector<HTMLInputElement>('[data-agent-profile="agent"] input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(true);
    const before = client.listNamedAgentProfiles.mock.calls.length;
    await act(async () => { checkbox.click(); });
    await settle();
    // The row toggle is the single entry to this list: it adds the name, and
    // the catalog reload is what the checkbox then reads.
    expect(client.patchConfig).toHaveBeenCalledWith({ disabled_named_profiles: ['agent'] });
    expect(client.listNamedAgentProfiles.mock.calls.length).toBeGreaterThan(before);
    expect(disabled).toEqual(['agent']);
    expect(queries.getQueryState(['agentProfiles', 'cwd', '/fixture', 'effective'])?.isInvalidated).toBe(true);
  });
});

describe('default main profile settings', () => {
  it('shows the board controls without a duplicate Todo explanation', async () => {
    await renderAt('/', <AgentTaskSettings boardContent={<p>Real board owner slot</p>} />);
    expect(container.querySelector('#st-card-agent-todo')).toBeNull();
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

  it('uses the shared source badge and raw-file collapse in profile rows', async () => {
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    expect(row.querySelector('[data-profile-source-badge="user"]')?.textContent).toBe('User');
    expect(row.querySelector('[data-raw-file-collapse]')).not.toBeNull();
  });

  it('states plainly that nothing is declared rather than implying a restriction', async () => {
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    expect(row.querySelector('[data-subagent-policy="undeclared"]')?.textContent).toBe('Not declared');
    expect(row.textContent).not.toContain('Not reported');
    expect(row.textContent).not.toContain('Advisory');
  });

  it('shows top-level budgets, request params, and model-profile projections', async () => {
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    expect(row.textContent).toContain('Context budget: 4096');
    expect(row.textContent).toContain('Max completion tokens: 512');
    expect(row.textContent).toContain('request params: {"temperature":0.2,"stream":true}');
    expect(row.textContent).toContain('model settings: fixture/model-b');
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
    expect(dialog.textContent).toContain('Edit agent: agent');
    const effort = dialog.querySelector<HTMLElement>('[data-agent-thinking-effort]')!;
    expect(effort.getAttribute('data-agent-thinking-effort')).toBe('medium');
    await setInputValue(dialog.querySelector<HTMLInputElement>('[data-agent-model-alias]')!, 'fixture/model-b');
    expect(dialog.querySelector('[data-agent-thinking-effort]')?.getAttribute('data-agent-thinking-effort')).toBe('');
  });

  it('offers a separate follow-caller model pin for subagents and saves the literal inherit alias', async () => {
    const helper: NamedAgentProfile = {
      ...profile, name: 'helper', main: false, source_file: '/fixture/agents/helper.md',
      description: 'Helper',
    };
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile, helper] });
    client.updateNamedAgentProfile.mockResolvedValue({ ...helper, pinned_model_alias: 'inherit', thinking_effort: undefined });
    await render('sub');
    const row = container.querySelector('[data-agent-profile="helper"]')!;
    await act(async () => { [...row.querySelectorAll('button')].find((button) => button.textContent === 'Edit')!.click(); });
    const dialog = document.body.querySelector('[role="dialog"]')!;
    await act(async () => { dialog.querySelector<HTMLButtonElement>('#agent-model-alias')!.click(); });
    const options = openOptions();
    expect(options.some((option) => option.textContent?.includes('No model pin (unset)'))).toBe(true);
    const follow = options.find((option) => option.textContent?.includes('Follow caller (inherit)'))!;
    expect(follow).toBeDefined();
    await act(async () => { follow.click(); });
    expect(dialog.querySelector<HTMLInputElement>('[data-agent-model-alias]')?.value).toBe('inherit');
    expect(dialog.querySelector('[data-agent-thinking-effort]')?.getAttribute('data-agent-thinking-effort')).toBe('');
    await act(async () => { [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click(); });
    await settle();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('helper', expect.objectContaining({
      pinned_model_alias: 'inherit', thinking_effort: null,
    }));
  });

  it('does not offer caller inheritance for a main agent and explains an invalid manual value', async () => {
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    await act(async () => { [...row.querySelectorAll('button')].find((button) => button.textContent === 'Edit')!.click(); });
    const dialog = document.body.querySelector('[role="dialog"]')!;
    await act(async () => { dialog.querySelector<HTMLButtonElement>('#agent-model-alias')!.click(); });
    expect(openOptions().some((option) =>
      option.textContent?.includes('Follow caller (inherit)'))).toBe(false);
    await setInputValue(dialog.querySelector<HTMLInputElement>('[data-agent-model-alias]')!, 'inherit');
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('A main agent has no caller');
    expect([...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Save')?.disabled).toBe(true);
  });

  it('opens the editor at the shared md width and reports unsaved edits to the dirty guard', async () => {
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    const edit = [...row.querySelectorAll('button')].find((button) => button.textContent === 'Edit')!;
    await act(async () => { edit.click(); });
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.className).toContain('max-w-[640px]');
    const guardId = 'agent-profile-editor:user:agent';
    expect(dirtyReporter).toHaveBeenCalledWith(guardId, false);
    const description = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(description, 'Unsaved tweak');
      description.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(dirtyReporter).toHaveBeenCalledWith(guardId, true);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(description, 'Custom default');
      description.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(dirtyReporter).toHaveBeenCalledWith(guardId, false);
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
    expect(container.querySelector('[data-default-agent="true"] [data-saved-tick]')).not.toBeNull();
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
      'Server-wide · affects every agent with this name',
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
    expect(container.querySelector('[data-default-agent="true"]')?.textContent).toContain('model settings: fixture/model-b');
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
    dialog.querySelector<HTMLElement>('[data-tool-field="tools"] [data-tool-field-mode]')!;
  const toolsList = (dialog: HTMLElement) =>
    dialog.querySelector<HTMLTextAreaElement>('[data-tool-field-list="tools"]');
  const disallowedMode = (dialog: HTMLElement) =>
    dialog.querySelector<HTMLElement>('[data-tool-field="disallowedTools"] [data-tool-field-mode]')!;
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
    expect(await optionLabels(toolsMode(dialog))).toEqual([
      'Inherit',
      'Deny all',
      'Allow list only',
    ]);
    expect(toolsMode(dialog).getAttribute('data-tool-field-mode')).toBe('empty');
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
    expect(toolsMode(dialog).getAttribute('data-tool-field-mode')).toBe('list');
    expect(toolsList(dialog)!.value).toBe('Read, Bash');
    await setText(descriptionField(dialog), 'Touched description');
    const body = await save(dialog);
    expect(body['tools']).toBeUndefined();
    expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty('tools');
  });

  it('keeps an untouched absent field absent and writes the list the user types', async () => {
    const dialog = await openEditor({ tools: undefined });
    expect(toolsMode(dialog).getAttribute('data-tool-field-mode')).toBe('inherit');
    expect(toolsList(dialog)).toBeNull();
    await pickValue(toolsMode(dialog), 'data-tool-field-mode', 'list');
    await setText(toolsList(dialog)!, 'Read, Bash');
    await setText(descriptionField(dialog), 'Touched description');
    const body = await save(dialog);
    expect(body['tools']).toEqual(['Read', 'Bash']);
  });

  it('writes an explicit empty list when the allow list moves to the deny state', async () => {
    const dialog = await openEditor({ tools: ['Read'] });
    await pickValue(toolsMode(dialog), 'data-tool-field-mode', 'empty');
    await setText(descriptionField(dialog), 'Touched description');
    const body = await save(dialog);
    expect(body['tools']).toEqual([]);
  });

  it('clears the field when the allow list returns to inherit', async () => {
    const dialog = await openEditor({ tools: ['Read'] });
    await pickValue(toolsMode(dialog), 'data-tool-field-mode', 'inherit');
    await setText(descriptionField(dialog), 'Touched description');
    const body = await save(dialog);
    expect(body['tools']).toBeNull();
  });

  it('refuses a named-list state that names nothing until the user fills it in', async () => {
    const dialog = await openEditor({ tools: [] });
    await pickValue(toolsMode(dialog), 'data-tool-field-mode', 'list');
    await setText(descriptionField(dialog), 'Touched description');
    const button = [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Save')!;
    expect(button.disabled).toBe(true);
    expect(dialog.querySelector('[data-tool-field-error="tools"]')?.textContent).toContain(
      'Enter at least one tool name',
    );
    await pickValue(toolsMode(dialog), 'data-tool-field-mode', 'empty');
    expect(button.disabled).toBe(false);
    expect(dialog.querySelector('[data-tool-field-error="tools"]')).toBeNull();
  });

  it('tracks the disallowed list three-way as well', async () => {
    const dialog = await openEditor({ disallowed_tools: [] });
    expect(await optionLabels(disallowedMode(dialog))).toEqual([
      'Inherit',
      'Do not deny any tools',
      'Deny listed tools',
    ]);
    expect(disallowedMode(dialog).getAttribute('data-tool-field-mode')).toBe('empty');
    await setText(descriptionField(dialog), 'Touched description');
    const untouched = await save(dialog);
    expect(untouched['disallowed_tools']).toBeUndefined();
  });

  it('writes the deny list the user picks', async () => {
    const dialog = await openEditor({ disallowed_tools: ['WebSearch'] });
    expect(disallowedMode(dialog).getAttribute('data-tool-field-mode')).toBe('list');
    expect(disallowedList(dialog)!.value).toBe('WebSearch');
    await pickValue(disallowedMode(dialog), 'data-tool-field-mode', 'empty');
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
    expect(dialog.textContent).toContain('Restore the original of built-in agent "agent"?');
    // The row's copy pins fixture/model-a, so the warning spells the pin out.
    expect(dialog.textContent).toContain('pins model fixture/model-a');
    expect(dialog.textContent).toContain('backed up automatically');
    const callsBefore = client.listShippedAgentProfiles.mock.calls.length;
    const confirm = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Restore original')!;
    await act(async () => { confirm.click(); });
    await settle();
    expect(client.restoreShippedAgentProfile).toHaveBeenCalledWith('agent');
    expect(client.listShippedAgentProfiles.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(row.textContent).toContain('Original restored and agents reloaded.');
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
    expect(container.querySelector('#st-card-main-agents')?.textContent).toContain('Original restored and agents reloaded.');
  });
});

describe('child agent dispatch rights', () => {
  // The row states the switch and the preset list; a profile that declared
  // neither is not described as restricted.
  it('reads a declared switch and preset list into the row badge', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [{
      ...profile, can_spawn_subagents: true, allowed_subagents: ['explore', 'reviewer'],
    }] });
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    expect(row.querySelector('[data-subagent-policy="presets"]')?.textContent).toBe('explore, reviewer');
  });

  it('shows a hard leaf as off rather than as an empty preset list', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [{ ...profile, can_spawn_subagents: false }] });
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    expect(row.querySelector('[data-subagent-policy="leaf"]')?.textContent).toBe('Off');
    expect(row.textContent).not.toContain('Dispatch policy');
  });

  it('says not declared when the profile constrains nothing', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [{ ...profile, can_spawn_subagents: undefined }] });
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    expect(row.querySelector('[data-subagent-policy="undeclared"]')?.textContent).toBe('Not declared');
    expect(row.textContent).not.toContain('Advisory');
    expect(row.textContent).not.toContain('Strict');
  });

  it('turns the switch off from the editor with null, and never writes the lists beside it', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [{ ...profile, can_spawn_subagents: true, preferred_subagents: ['explore'] }] });
    client.updateNamedAgentProfile.mockResolvedValue({ ...profile, can_spawn_subagents: false });
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    await act(async () => { [...row.querySelectorAll('button')].find((button) => button.textContent === 'Edit')!.click(); });
    const dialog = document.body.querySelector('[role="dialog"]')!;
    // One three-state control: a switch could not express "not declared", so
    // the segments carry the whole value.
    const choices = dialog.querySelectorAll<HTMLButtonElement>('[data-profile-field="canSpawnSubagents"] [data-dispatch-can-spawn-mode]');
    expect([...choices].map((button) => button.textContent)).toEqual(['Not declared', 'Allowed', 'Off']);
    expect(dialog.querySelector('[data-dispatch-can-spawn-mode="on"][aria-pressed="true"]')).not.toBeNull();
    await act(async () => { choices[2]!.click(); });
    await act(async () => { [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click(); });
    await settle();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('agent', expect.objectContaining({ can_spawn_subagents: false }));
    const body = client.updateNamedAgentProfile.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('allowed_subagents');
    expect(body).not.toHaveProperty('preferred_subagents');
    expect(body).not.toHaveProperty('deny_subagents');
    expect(body).not.toHaveProperty('subagent_policy');
  });

  it('clears an inherited switch with null instead of writing true', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [{ ...profile, can_spawn_subagents: undefined }] });
    client.updateNamedAgentProfile.mockResolvedValue({ ...profile, can_spawn_subagents: false });
    await render();
    const row = container.querySelector('[data-default-agent="true"]')!;
    await act(async () => { [...row.querySelectorAll('button')].find((button) => button.textContent === 'Edit')!.click(); });
    const dialog = document.body.querySelector('[role="dialog"]')!;
    await act(async () => { dialog.querySelector<HTMLButtonElement>('[data-profile-field="canSpawnSubagents"] [data-dispatch-can-spawn-mode="off"]')!.click(); });
    await act(async () => { [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click(); });
    await settle();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('agent', expect.objectContaining({ can_spawn_subagents: false }));
  });
});


it('previews menu permission changes in the legacy profile dialog before saving', async () => {
  client.listModels.mockResolvedValue({ items: [
    { id: 'fixture/model-a', provider_id: 'fixture', remote_id: 'model-a' },
    { id: 'fixture/model-b', provider_id: 'fixture', remote_id: 'model-b' },
  ] });
  client.klient.rest.agents.previewModelMenu.mockResolvedValue({ restrict_models_to_menu: true,
    declared_model_menu: { aliases: ['fixture/model-b'], identities: ['fixture/model-b'], default_alias: 'fixture/model-b' },
    effective_model_aliases: ['fixture/model-b'], added_model_identities: ['fixture/model-b'], removed_model_identities: ['fixture/model-a'],
  });
  client.updateNamedAgentProfile.mockResolvedValue({ ...profile, restrict_models_to_menu: true, pinned_model_alias: 'fixture/model-b' });
  await render();
  const row = container.querySelector('[data-default-agent="true"]')!;
  await act(async () => [...row.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Edit')!.click());
  const dialog = document.body.querySelector('[role="dialog"]')!;
  await setInputValue(dialog.querySelector<HTMLInputElement>('[data-agent-model-alias]')!, 'fixture/model-b');
  await act(async () => dialog.querySelector<HTMLInputElement>('[data-profile-field="restrictModelsToMenu"] input')!.click());
  await settle();
  expect(dialog.querySelector('[data-menu-removed]')?.textContent).toContain('fixture/model-a');
  expect(dialog.querySelector('[data-menu-save-warning]')?.textContent).toContain('fixture/model-a');
  expect(client.updateNamedAgentProfile).not.toHaveBeenCalled();
  await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Save')!.click());
  await settle();
  expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('agent', expect.objectContaining({ restrict_models_to_menu: true, pinned_model_alias: 'fixture/model-b' }));
});

/**
 * A workspace's own page links here with `?workspace=<id>`, so the page has to
 * load THAT workspace's profiles. Falling back to the most recently opened
 * workspace would edit a different one while looking correct, and falling back
 * to the global catalog would show profiles the workspace does not own.
 */
describe('the workspace a profile page was linked to', () => {
  beforeEach(() => {
    client.listWorkspaces.mockResolvedValue({ items: [
      // Most recently opened: the fallback this must NOT silently take.
      { id: 'ws-recent', root: '/fixture/recent', name: 'Recent', last_opened_at: '2026-09-30T00:00:00Z' },
      { id: 'ws-two', root: '/fixture/two', name: 'Two', last_opened_at: '2026-01-02T00:00:00Z' },
      { id: 'ws-three', root: '/fixture/three', name: 'Three', last_opened_at: '2026-01-01T00:00:00Z' },
    ] });
  });

  it('requests the workspace the link named, not the most recent one', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [{ ...profile, workspace_id: 'ws-three' }] });
    await render('main', 'ws-three');
    // The actual request, not the href: this is what proves the scope.
    expect(client.listNamedAgentProfiles).toHaveBeenCalledWith({ workspace_id: 'ws-three', effective: true });
    expect(client.listNamedAgentProfiles).not.toHaveBeenCalledWith(expect.objectContaining({ workspace_id: 'ws-recent' }));
    expect(client.listNamedAgentProfiles).not.toHaveBeenCalledWith({ mode: 'global' });
  });

  it('keeps a second workspace from leaking into the first one’s page', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [{ ...profile, workspace_id: 'ws-two' }] });
    await render('main', 'ws-two');
    expect(client.listNamedAgentProfiles).toHaveBeenCalledWith({ workspace_id: 'ws-two', effective: true });
    const calls = client.listNamedAgentProfiles.mock.calls.map((call) => JSON.stringify(call[0]));
    expect(calls.every((call) => !call.includes('ws-three'))).toBe(true);
  });

  it('says so when the linked workspace is not in this server’s list, and still reads it', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [] });
    await render('main', 'ws-gone');
    // The link is followed as written — no fallback to recency, no fallback to
    // the global catalog — and the page states the fact the reader needs to
    // explain the empty rows instead of showing a blank picker.
    expect(client.listNamedAgentProfiles).toHaveBeenCalledWith({ workspace_id: 'ws-gone', effective: true });
    expect(client.listNamedAgentProfiles).not.toHaveBeenCalledWith({ mode: 'global' });
    expect(container.querySelector('[data-named-agents-workspace-missing]')?.textContent)
      .toContain('Not in this server’s workspace list');
  });

  it('keeps the note off a page whose workspace is in the list', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [] });
    await render('main', 'ws-two');
    expect(container.querySelector('[data-named-agents-workspace-missing]')).toBeNull();
  });

  it('follows a query-only move on the page it is already mounted in', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [] });
    await renderAt('/?workspace=ws-two', <><NamedAgentProfilesCard bucket="main" /><AddressDriver /></>);
    expect(client.listNamedAgentProfiles).toHaveBeenCalledWith({ workspace_id: 'ws-two', effective: true });
    // The picker's own data attribute is the page's answer to "which workspace
    // am I on", so it is read here rather than a request that a cached query
    // would not repeat.
    const on = () => container.querySelector('[data-named-agents-workspace]')?.getAttribute('data-named-agents-workspace');
    expect(on()).toBe('ws-two');

    // An explicit new address that names another workspace. A copy of the
    // selection in state would survive this move and keep reading — and
    // editing — ws-two while the address said ws-three.
    const mark = client.listNamedAgentProfiles.mock.calls.length;
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-drive-to="ws-three"]')!.click(); });
    await settle();
    expect(on()).toBe('ws-three');
    const afterMove = client.listNamedAgentProfiles.mock.calls.slice(mark).map((call) => JSON.stringify(call[0]));
    expect(afterMove.some((call) => call.includes('ws-three'))).toBe(true);
    expect(afterMove.every((call) => !call.includes('ws-two'))).toBe(true);

    // Back is the same move in reverse: it lands where the address lands, not
    // where the picker was last left.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-drive-back]')!.click(); });
    await settle();
    expect(on()).toBe('ws-two');
  });
});

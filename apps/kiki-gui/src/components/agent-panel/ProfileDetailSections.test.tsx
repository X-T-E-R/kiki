// @vitest-environment jsdom

/**
 * Profile detail provenance: a running profile reads its definition through
 * the binding it was launched with — the workspace the query names and the
 * source file the panel reports — so a same-named profile from another
 * workspace or directory can never be dressed up as the effective one, and a
 * model/effort source is only named when the bound definition proves it.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentPanelProfile, NamedAgentProfile } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { ProfileDetailSections, type ProfileDetailSectionsProps } from './ProfileDetailSections';
import { AgentDetailDrawer } from './AgentDetailDrawer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { client, panelRead } = vi.hoisted(() => ({
  client: { listNamedAgentProfiles: vi.fn(), readHostFile: vi.fn() }, panelRead: vi.fn(),
}));
vi.mock('../../state/connection', () => ({ useOptionalConnection: () => ({ client, klient: { global: { agentPanel: { read: panelRead } } }, scopeId: 'local' }) }));

const BOUND_FILE = '/ws-one/.kiki/agents/agent.md';
const OTHER_FILE = '/ws-two/.kiki/agents/agent.md';

const runningProfile: AgentPanelProfile = {
  name: 'agent',
  source: BOUND_FILE,
  source_file: BOUND_FILE,
  definition_id: 'definition-one',
  description: 'Running description',
  model: 'fixture/model-a',
  thinking_effort: 'medium',
  tools: ['Read'],
};

/** The definition the running profile was launched from. */
const boundDefinition: NamedAgentProfile = {
  name: 'agent',
  source: 'workspace',
  workspace_id: 'ws-one',
  source_file: BOUND_FILE,
  main: true,
  disabled: false,
  routes: [],
  when_to_use: 'Bound definition when-to-use',
  pinned_model_alias: 'fixture/model-a',
  thinking_effort: 'medium',
  context_budget: 4096,
  model_profiles: [{ alias: 'fixture/model-b', context_budget: 2048 }],
};

/** A different definition that happens to share the name. */
const otherDefinition: NamedAgentProfile = {
  name: 'agent',
  source: 'workspace',
  workspace_id: 'ws-two',
  source_file: OTHER_FILE,
  main: true,
  disabled: false,
  routes: [],
  when_to_use: 'OTHER definition when-to-use',
  pinned_model_alias: 'other/model',
  thinking_effort: 'max',
  context_budget: 999,
  model_profiles: [{ alias: 'other/model-b', context_budget: 111 }],
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client.readHostFile.mockResolvedValue('---\nname: agent\n---\n\nBound body.');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function render(props: ProfileDetailSectionsProps): Promise<void> {
  await act(async () => {
    root.render(<I18nProvider><ProfileDetailSections {...props} /></I18nProvider>);
  });
  await settle();
}

function section(name: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-profile-section="${name}"]`)!;
}

describe('running profile definition lookup', () => {
  it('scopes the definition lookup to the queried workspace', async () => {
    client.listNamedAgentProfiles.mockImplementation(async (query?: unknown) => (
      query === 'ws-one'
        ? { items: [boundDefinition], complete: true }
        : { items: [otherDefinition], complete: true }
    ));
    await render({ profile: runningProfile, query: { workspace_id: 'ws-one', profile: 'agent' } });

    expect(client.listNamedAgentProfiles).toHaveBeenCalledWith('ws-one');
    expect(section('intent').textContent).toContain('Bound definition when-to-use');
    expect(section('model').textContent).toContain('4096');
    expect(section('model').textContent).toContain('fixture/model-b');
    // The other workspace's definition never reaches the effective columns.
    expect(section('intent').textContent).not.toContain('OTHER definition when-to-use');
    expect(section('model').textContent).not.toContain('999');
    expect(container.textContent).not.toContain('other/model');
    expect(container.querySelector('[data-disk-definition]')).toBeNull();
  });

  it('picks the definition whose source file matches the running profile', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({
      items: [otherDefinition, boundDefinition],
      complete: true,
    });
    await render({ profile: runningProfile });

    expect(section('identity').textContent).toContain(BOUND_FILE);
    expect(section('intent').textContent).toContain('Bound definition when-to-use');
    expect(section('model').textContent).toContain('4096');
    expect(section('model').textContent).not.toContain('999');
    expect(container.querySelector('[data-disk-definition]')).toBeNull();
  });

  it('lists a same-named definition from another file on its own, not as the effective one', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [otherDefinition], complete: true });
    await render({ profile: runningProfile, query: { session_id: 's-one', agent_id: 'main' } });

    // A session query names no workspace, so the lookup stays unscoped — the
    // binding key is the source file, which the other definition does not match.
    expect(client.listNamedAgentProfiles).toHaveBeenCalledWith();
    expect(section('intent').textContent).not.toContain('OTHER definition when-to-use');
    expect(section('model').textContent).not.toContain('999');
    expect(section('model').textContent).not.toContain('other/model');
    expect(container.querySelector('[data-value-origin="model"]')?.textContent).toBe('Not reported');

    const disk = container.querySelector<HTMLElement>('[data-disk-definition]')!;
    expect(disk).not.toBeNull();
    expect(disk.textContent).toContain('Current on-disk version');
    expect(disk.textContent).toContain(OTHER_FILE);
    expect(disk.textContent).toContain('OTHER definition when-to-use');
    expect(disk.textContent).toContain('999');
    expect(disk.textContent).toContain('The running agent is bound to a different definition');
  });

  it('keys the identity-only panel by the identity source file as well', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [otherDefinition], complete: true });
    await render({
      identity: {
        id: 'agent-1',
        profile: 'agent',
        label: 'agent',
        status: 'running',
        context: 'live',
        sourceFile: BOUND_FILE,
        model: 'fixture/model-a',
      },
    });

    expect(section('intent').textContent).not.toContain('OTHER definition when-to-use');
    expect(container.querySelector('[data-disk-definition]')).not.toBeNull();
    expect(container.querySelector('[data-disk-definition]')!.textContent).toContain(OTHER_FILE);
  });

  it('recovers source and derived leases from the bound definition and opens the full profile', async () => {
    const onOpenTarget = vi.fn();
    client.listNamedAgentProfiles.mockResolvedValue({
      items: [{ ...boundDefinition, allowed_subagents: ['explore'] }],
      complete: true,
    });
    await render({
      profile: { ...runningProfile, source: undefined, description: undefined },
      query: { workspace_id: 'ws-one', profile: 'agent' },
      onOpenTarget,
    });

    expect(container.querySelector('[data-profile-source-badge="workspace"]')?.textContent).toBe('Workspace');
    expect(section('intent').textContent).toContain('Bound definition when-to-use');
    expect(section('intent').textContent).not.toContain('Unrestricted');
    expect(section('subagents').textContent).toContain('explore');
    expect(section('subagents').textContent).not.toContain('Unrestricted');

    await act(async () => {
      section('subagents').querySelector<HTMLButtonElement>('button')!.click();
    });
    expect(onOpenTarget).toHaveBeenCalledWith({ kind: 'profile-draft', profile: 'explore' });
  });

  it('localizes stable scoped-profile diagnostic codes', async () => {
    localStorage.setItem('kiki.locale', 'zh');
    client.listNamedAgentProfiles.mockResolvedValue({
      items: [{
        ...boundDefinition,
        allowed_subagents: [{
          name: 'missing-writer',
          source: './_private/missing.md',
          scope: 'private',
          status: 'unavailable',
          diagnostic: 'Source profile is unavailable',
          diagnostic_code: 'agent_profile_source.unavailable',
        }],
      }],
      complete: true,
    });
    await render({ profile: runningProfile, query: { workspace_id: 'ws-one', profile: 'agent' } });

    expect(section('subagents').textContent).toContain('来源配置档不可用。');
    expect(section('subagents').textContent).not.toContain('Source profile is unavailable');
  });
});

describe('model and effort source labels', () => {
  it('reports no source instead of claiming the profile for an unproven value', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [], complete: true });
    await render({ profile: runningProfile, query: { workspace_id: 'ws-one', profile: 'agent' } });

    expect(container.querySelector('[data-value-origin="model"]')?.textContent).toBe('Not reported');
    expect(container.querySelector('[data-value-origin="effort"]')?.textContent).toBe('Not reported');
  });

  it('names the profile only when the bound definition declares the effective value', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [boundDefinition], complete: true });
    await render({ profile: runningProfile, query: { workspace_id: 'ws-one', profile: 'agent' } });

    expect(container.querySelector('[data-value-origin="model"]')?.textContent).toBe('Profile');
    expect(container.querySelector('[data-value-origin="effort"]')?.textContent).toBe('Profile');
  });

  it('uses reported provenance and labels the effective-value column explicitly', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [], complete: true });
    await render({
      profile: {
        ...runningProfile,
        model_source: 'route',
        effort_source: 'config',
      } as AgentPanelProfile & { readonly model_source: 'route'; readonly effort_source: 'config' },
      query: { workspace_id: 'ws-one', profile: 'agent' },
    });

    expect(container.querySelector('[data-value-origin="model"]')?.textContent).toBe('Route');
    expect(container.querySelector('[data-value-origin="effort"]')?.textContent).toBe('Configuration');
    expect(section('model').textContent).toContain('DeclaredEffectiveSource');
  });

  it('keeps the lock badge and drops the source label for a route-locked value', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [], complete: true });
    await render({
      profile: { ...runningProfile, locked_model: 'fixture/model-a', locked_effort: 'medium' },
      query: { session_id: 's-one', agent_id: 'main' },
    });

    expect(container.querySelector('[data-value-origin="model"]')).toBeNull();
    expect(container.querySelector('[data-value-origin="effort"]')).toBeNull();
    expect(section('model').textContent).toContain('Locked by profile, immutable in session');
  });
});

describe('effective prompt details', () => {
  const prompt: import('@kiki/protocol').AgentPromptDiagnostics = {
    identity: { delegation_position: 'main', profile: 'agent', model_alias: 'fixture/model-a', executor: 'native' },
    binding_revision: 'bound-7', disk_revision: 'disk-8', disk_changed: true,
    apply_on: 'next-binding-or-context-rebuild', lease_model_prompts: 'preserve',
    channels: [
      { id: 'system.shared', channel: 'system', state: 'effective', selection: 'common', sources: [{ surface: 'global', kind: 'file', path: '/fixture/prompt/common.toml', line: 4, order: 1 }] },
      { id: 'system.base', channel: 'system', state: 'shadowed', selection: 'main', reason: 'Replaced by selected model overlay', sources: [] },
      { id: 'tool.read.guidance', channel: 'tool', state: 'effective', selection: 'main', sources: [{ surface: 'profile', kind: 'inline' }] },
      { id: 'cognition.steering', channel: 'cognition_steering', state: 'inactive', selection: 'off', reason: 'Turned off in this branch', sources: [] },
      { id: 'cognition.anchor', channel: 'cognition_anchor', state: 'effective', selection: 'main', anchor_steps: 2, anchor_scope: 'turn', sources: [] },
    ],
    request: { system_prompt_hash: 'actual-system-hash', tools_hash: 'actual-tools-hash', at: 1_790_979_200_000, turn_step: 't2.1', attempt: 'attempt-1' },
  };

  it('shows identity, four channels, source order, disk drift and unknown request anchor without guessing', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [], complete: true });
    await render({ profile: runningProfile, prompt });
    const details = section('prompt');
    expect(details.querySelector('[data-prompt-identity]')?.textContent).toContain('Main agent');
    expect(details.querySelectorAll('[data-prompt-channel-group]')).toHaveLength(4);
    expect(details.querySelector('[data-prompt-disk-changed]')?.textContent).toContain('next binding or context rebuild');
    expect(details.querySelector('[data-prompt-source]')?.textContent).toContain('/fixture/prompt/common.toml');
    expect(details.querySelector('[data-prompt-source]')?.textContent).toContain(':4');
    expect(details.querySelector('[data-prompt-state="shadowed"]')?.textContent).toContain('Replaced by selected model overlay');
    expect(details.querySelector('[data-prompt-request]')?.textContent).toContain('actual-system-hash');
    expect(details.querySelector('[data-prompt-request]')?.textContent).toContain('did not record whether the anchor was applied');
    expect(details.querySelector('[data-prompt-request]')?.textContent).not.toContain('did not replace');
    expect(details.textContent).toContain('First 2 request steps');
  });

  it('checks all branches only on demand and shows file errors for the selected agent', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [], complete: true });
    const checks = [
      { surface: 'model', branch: 'common', channel: 'cognition_overlay', path: '/fixture/common.md', status: 'ok' },
      { surface: 'model', branch: 'independent', channel: 'cognition_anchor', path: '/fixture/independent/anchor.md', status: 'error', reason: 'File not found', model_alias: 'fixture/model-a' },
    ];
    panelRead.mockResolvedValue({ prompt: { ...prompt, file_checks: checks } });
    await render({ profile: runningProfile, query: { session_id: 'session-files', agent_id: 'child-files' }, prompt });
    expect(panelRead).not.toHaveBeenCalled();
    await act(async () => section('prompt').querySelector<HTMLButtonElement>('[data-prompt-file-check-run]')!.click());
    expect(panelRead).toHaveBeenCalledWith({ session_id: 'session-files', agent_id: 'child-files', check_all_prompt_files: true }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const results = section('prompt').querySelector('[data-prompt-file-check-results]')!;
    expect(results.textContent).toContain('Files checked: 2 · Issues: 1');
    expect(results.getAttribute('open')).not.toBeNull();
    expect(results.querySelector('[data-prompt-file-status="error"]')?.textContent).toContain('Externally delegated agent');
    expect(results.textContent).toContain('File not found');
    expect(section('prompt').querySelector('[data-prompt-request]')?.textContent).toContain('actual-system-hash');
  });

  it('distinguishes no files from omitted audit results and clears results when the agent changes', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [], complete: true });
    panelRead.mockResolvedValueOnce({ prompt: { ...prompt, file_checks: [] } }).mockResolvedValueOnce({ prompt });
    const props = { profile: runningProfile, query: { session_id: 'session-files', agent_id: 'child-one' }, prompt };
    await render(props);
    await act(async () => section('prompt').querySelector<HTMLButtonElement>('[data-prompt-file-check-run]')!.click());
    expect(section('prompt').querySelector('[data-prompt-file-check-empty]')?.textContent).toContain('no prompt files');
    await act(async () => section('prompt').querySelector<HTMLButtonElement>('[data-prompt-file-check-run]')!.click());
    expect(section('prompt').querySelector('[data-prompt-file-check-missing]')?.textContent).toContain('did not include file-check results');
    expect(section('prompt').querySelector('[data-prompt-file-check-empty]')).toBeNull();
    await render({ ...props, query: { session_id: 'session-files', agent_id: 'child-two' } });
    expect(section('prompt').querySelector('[data-prompt-file-check-missing]')).toBeNull();
  });

  it('shows audit failures and supports a fresh explicit retry', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [], complete: true });
    panelRead.mockRejectedValueOnce(new Error('Audit unavailable')).mockResolvedValueOnce({ prompt: { ...prompt, file_checks: [] } });
    await render({ profile: runningProfile, query: { session_id: 'session-files', agent_id: 'main' }, prompt });
    await act(async () => section('prompt').querySelector<HTMLButtonElement>('[data-prompt-file-check-run]')!.click());
    expect(section('prompt').querySelector('[role="alert"]')?.textContent).toContain('Audit unavailable');
    await act(async () => section('prompt').querySelector<HTMLButtonElement>('[data-prompt-file-check-run]')!.click());
    expect(section('prompt').querySelector('[role="alert"]')).toBeNull();
    expect(section('prompt').querySelector('[data-prompt-file-check-empty]')).not.toBeNull();
  });

  it('shows no request evidence when absent and marks unavailable bindings honestly', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [], complete: true });
    await render({ profile: runningProfile, prompt: { ...prompt, request: undefined } });
    expect(section('prompt').textContent).toContain('No request evidence has been recorded');
    expect(section('prompt').textContent).not.toContain('actual-system-hash');
    await render({ profile: runningProfile, promptUnavailable: true });
    expect(section('prompt').textContent).toContain('bound prompts for this agent are unavailable');
    expect(section('prompt').querySelector('[data-prompt-state="effective"]')).toBeNull();
  });
});

it('reads prompt evidence for the selected child in its own session, never main', async () => {
  client.listNamedAgentProfiles.mockResolvedValue({ items: [], complete: true });
  panelRead.mockResolvedValue({ context: 'live', owner: { agent_id: 'child-two' }, available: true, targets: [],
    prompt: { identity: { delegation_position: 'sub', profile: 'reviewer', model_alias: 'fixture/model-b', executor: 'native' },
      apply_on: 'next-binding-or-context-rebuild', channels: [],
      request: { system_prompt_hash: 'child-hash', tools_hash: 'child-tools', at: 1790979200000 } },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const identity = { id: 'child-two', sessionId: 'session-two', profile: 'reviewer', label: 'Reviewer', context: 'live' as const, status: 'completed' as const };
  await act(async () => root.render(<QueryClientProvider client={queryClient}><I18nProvider>
    <AgentDetailDrawer target={{ kind: 'profile', identity }} onClose={() => undefined} />
  </I18nProvider></QueryClientProvider>));
  await settle();
  expect(panelRead).toHaveBeenCalledWith({ session_id: 'session-two', agent_id: 'child-two' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(document.querySelector('[data-prompt-request]')?.textContent).toContain('child-hash');
  expect(document.querySelector('[data-prompt-identity]')?.textContent).toContain('Subagent');
  await act(async () => root.render(<I18nProvider><span /></I18nProvider>));
  queryClient.clear();
});

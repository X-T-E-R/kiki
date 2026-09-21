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

const { client } = vi.hoisted(() => ({
  client: { listNamedAgentProfiles: vi.fn(), readHostFile: vi.fn() },
}));
vi.mock('../../state/connection', () => ({ useOptionalConnection: () => ({ client }) }));

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
      items: [{ ...boundDefinition, subagents: ['explore'] }],
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

// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionCreate } from '@moonshot-ai/protocol';

import { I18nProvider } from '../i18n';
import type { NamedAgentProfile } from '../lib/client';
import { buildAgentProfileOptions, resolveSelectedEffort } from './Composer';
import {
  buildNewSessionCreate,
  isAbsoluteCwdPath,
  useNewSessionDraft,
  type NewSessionDraftState,
} from './NewSessionDraft';

const { client, navigate } = vi.hoisted(() => ({
  client: {
    listWorkspaces: vi.fn(),
    getConfig: vi.fn(),
    listModels: vi.fn(),
    listNamedAgentProfiles: vi.fn(),
    getAuth: vi.fn(),
    createSession: vi.fn(),
  },
  navigate: vi.fn(),
}));

vi.mock('../state/connection', () => ({
  useConnection: () => ({ client }),
}));
vi.mock('../host', () => ({
  useHost: () => ({ kind: 'browser' }),
}));
vi.mock('./dirtyGuard', () => ({
  useGuardedNavigate: () => navigate,
}));

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
let latestDraftState: NewSessionDraftState | undefined;

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  latestDraftState = undefined;
  localStorage.clear();
  navigate.mockReset();
  client.listWorkspaces.mockReset().mockResolvedValue({ items: [] });
  client.getConfig.mockReset().mockResolvedValue({});
  client.listModels.mockReset().mockResolvedValue({ items: [] });
  client.listNamedAgentProfiles.mockReset().mockResolvedValue({ items: [] });
  client.getAuth.mockReset().mockResolvedValue({ ready: true });
  client.createSession.mockReset().mockResolvedValue({ id: 'session-new' });
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

function DraftHarness(props: { initialWorkspaceId?: string; initialProfile?: string }) {
  latestDraftState = useNewSessionDraft(props);
  return null;
}

async function renderDraft(
  props: { initialWorkspaceId?: string; initialProfile?: string } = {},
): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(I18nProvider, null, createElement(DraftHarness, props)),
      ),
    );
  });
}

async function settleDraft(predicate: (state: NewSessionDraftState) => boolean): Promise<NewSessionDraftState> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (latestDraftState !== undefined && predicate(latestDraftState)) return latestDraftState;
  }
  throw new Error('new-session draft did not settle');
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('isAbsoluteCwdPath', () => {
  it('accepts POSIX, Windows-drive, and UNC absolute paths', () => {
    expect(isAbsoluteCwdPath('/home/you/project')).toBe(true);
    expect(isAbsoluteCwdPath('/')).toBe(true);
    expect(isAbsoluteCwdPath('C:/work/project')).toBe(true);
    expect(isAbsoluteCwdPath('C:\\work\\project')).toBe(true);
    expect(isAbsoluteCwdPath('\\\\server\\share\\project')).toBe(true);
  });

  it('rejects relative paths, drive letters without a separator, and empties', () => {
    expect(isAbsoluteCwdPath('project')).toBe(false);
    expect(isAbsoluteCwdPath('./project')).toBe(false);
    expect(isAbsoluteCwdPath('~/project')).toBe(false);
    expect(isAbsoluteCwdPath('C:project')).toBe(false);
    expect(isAbsoluteCwdPath('')).toBe(false);
    expect(isAbsoluteCwdPath('  ')).toBe(false);
  });
});

describe('buildNewSessionCreate', () => {
  it('applies every create-supported execution control before a skill handoff can run', () => {
    expect(
      buildNewSessionCreate({
        cwd: '',
        workspaceId: 'wd_fixture_0123456789ab',
        profile: 'agent',
        model: 'provider/model',
        thinking: 'high',
        permissionMode: 'yolo',
        planMode: true,
        swarmMode: true,
      }),
    ).toEqual({
      workspace_id: 'wd_fixture_0123456789ab',
      agent_config: {
        profile: 'agent',
        model: 'provider/model',
        thinking: 'high',
        permission_mode: 'yolo',
        plan_mode: true,
        swarm_mode: true,
      },
    });
  });
});

describe('useNewSessionDraft agent profile scope', () => {
  const workspace = (id: string, name: string) => ({
    id,
    name,
    root: `/workspace/${name.toLowerCase()}`,
    pinned: false,
    last_opened_at: '2026-09-05T00:00:00.000Z',
    session_count: 0,
  });
  const profile = (
    name: string,
    model?: string,
    thinking?: string,
    main = true,
  ): NamedAgentProfile => ({
    name,
    source: name === 'agent' ? 'builtin' : 'workspace',
    main,
    pinned_model_alias: model,
    thinking_effort: thinking,
    disabled: false,
    routes: [],
  });
  const model = (name: string, effort: string) => ({
    model: name,
    provider: 'fixture',
    support_efforts: [effort],
    default_effort: effort,
  });
  const sentBody = async (state: NewSessionDraftState): Promise<SessionCreate> => {
    await act(async () => {
      state.send('Start work', []);
    });
    await settleDraft(() => client.createSession.mock.calls.length > 0);
    return client.createSession.mock.calls.at(-1)?.[0] as SessionCreate;
  };

  it('blocks creation until an initial agent is validated and then sends its workspace pins', async () => {
    const catalog = deferred<{ items: NamedAgentProfile[] }>();
    client.listWorkspaces.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha')] });
    client.listModels.mockResolvedValue({ items: [model('provider/alpha', 'high')] });
    client.listNamedAgentProfiles.mockReturnValue(catalog.promise);

    await renderDraft({ initialWorkspaceId: 'wd_alpha', initialProfile: 'workspace-main' });
    let state = await settleDraft((value) =>
      value.agentProfileCatalogPending && client.listNamedAgentProfiles.mock.calls.length === 1
    );
    await act(async () => {
      state.send('Too early', []);
    });
    expect(client.createSession).not.toHaveBeenCalled();

    catalog.resolve({
      items: [profile('agent'), profile('workspace-main', 'provider/alpha', 'high')],
    });
    state = await settleDraft((value) =>
      !value.agentProfileCatalogPending
      && value.agentProfile === 'workspace-main'
      && value.modelOverride === 'provider/alpha'
      && value.effectiveEffort === 'high'
    );
    const body = await sentBody(state);

    expect(client.listNamedAgentProfiles).toHaveBeenCalledWith('wd_alpha');
    expect(client.listNamedAgentProfiles).not.toHaveBeenCalledWith(undefined);
    expect(body).toMatchObject({
      workspace_id: 'wd_alpha',
      agent_config: {
        profile: 'workspace-main',
        model: 'provider/alpha',
        thinking: 'high',
      },
    });
  });

  it('ignores an initial agent that is not a main profile in the target workspace', async () => {
    client.listWorkspaces.mockResolvedValue({ items: [workspace('wd_beta', 'Beta')] });
    client.listNamedAgentProfiles.mockResolvedValue({
      items: [profile('agent'), profile('workspace-helper', 'provider/beta', 'low', false)],
    });

    await renderDraft({ initialWorkspaceId: 'wd_beta', initialProfile: 'workspace-helper' });
    const state = await settleDraft((value) => !value.agentProfileCatalogPending);

    expect(client.listNamedAgentProfiles).toHaveBeenCalledWith('wd_beta');
    expect(state.agentProfile).toBe('agent');
    expect(state.modelOverride).toBeUndefined();
  });

  it('falls back before sending when the selected profile does not exist in the next workspace', async () => {
    client.listWorkspaces.mockResolvedValue({
      items: [workspace('wd_alpha', 'Alpha'), workspace('wd_beta', 'Beta')],
    });
    client.listModels.mockResolvedValue({ items: [model('provider/alpha', 'low')] });
    client.listNamedAgentProfiles.mockImplementation(async (workspaceId?: string) => ({
      items: workspaceId === 'wd_beta'
        ? [profile('agent'), profile('beta-only')]
        : [profile('agent'), profile('alpha-only', 'provider/alpha', 'low')],
    }));

    await renderDraft({ initialWorkspaceId: 'wd_alpha' });
    let state = await settleDraft((value) =>
      value.agentProfileCatalogMode.mode === 'workspace'
      && client.listNamedAgentProfiles.mock.calls.length === 1
    );
    await act(async () => {
      state.setAgentProfile('alpha-only');
    });
    state = await settleDraft((value) => value.agentProfile === 'alpha-only');
    await act(async () => {
      state.selectWorkspace('wd_beta');
      state.send('Must not use Alpha', []);
    });
    expect(client.createSession).not.toHaveBeenCalled();
    state = await settleDraft((value) =>
      !value.agentProfileCatalogPending
      && value.effectiveWorkspace?.id === 'wd_beta'
      && value.agentProfile === 'agent'
      && value.modelOverride === undefined
    );
    const body = await sentBody(state);

    expect(body).toMatchObject({
      workspace_id: 'wd_beta',
      agent_config: { profile: 'agent' },
    });
    expect(body.agent_config?.model).toBeUndefined();
    expect(body.agent_config?.thinking).toBeUndefined();
  });

  it('reapplies the next workspace definition before sending a same-name profile', async () => {
    client.listWorkspaces.mockResolvedValue({
      items: [workspace('wd_alpha', 'Alpha'), workspace('wd_beta', 'Beta')],
    });
    client.listModels.mockResolvedValue({
      items: [model('provider/alpha', 'low'), model('provider/beta', 'high')],
    });
    client.listNamedAgentProfiles.mockImplementation(async (workspaceId?: string) => ({
      items: workspaceId === 'wd_beta'
        ? [profile('agent'), profile('workspace-choice', 'provider/beta', 'high')]
        : [profile('agent'), profile('workspace-choice', 'provider/alpha', 'low')],
    }));

    await renderDraft({ initialWorkspaceId: 'wd_alpha' });
    let state = await settleDraft(() => client.listNamedAgentProfiles.mock.calls.length === 1);
    await act(async () => {
      state.setAgentProfile('workspace-choice');
    });
    state = await settleDraft((value) =>
      value.modelOverride === 'provider/alpha' && value.effectiveEffort === 'low'
    );
    await act(async () => {
      state.selectWorkspace('wd_beta');
      state.send('Must not use Alpha pins', []);
    });
    expect(client.createSession).not.toHaveBeenCalled();
    state = await settleDraft((value) =>
      !value.agentProfileCatalogPending
      && value.agentProfile === 'workspace-choice'
      && value.modelOverride === 'provider/beta'
      && value.effectiveEffort === 'high'
    );
    const body = await sentBody(state);

    expect(body).toMatchObject({
      workspace_id: 'wd_beta',
      agent_config: {
        profile: 'workspace-choice',
        model: 'provider/beta',
        thinking: 'high',
      },
    });
  });

  it('disables profiles for a custom cwd without querying or submitting another workspace catalog', async () => {
    client.listWorkspaces.mockResolvedValue({
      items: [workspace('wd_alpha', 'Alpha'), workspace('wd_beta', 'Beta')],
    });
    client.listModels.mockResolvedValue({ items: [model('provider/alpha', 'low')] });
    client.listNamedAgentProfiles.mockImplementation(async (workspaceId?: string) => ({
      items: workspaceId === 'wd_beta'
        ? [profile('agent'), profile('beta-only', 'provider/beta', 'high')]
        : [profile('agent'), profile('alpha-only', 'provider/alpha', 'low')],
    }));

    await renderDraft({ initialWorkspaceId: 'wd_alpha' });
    let state = await settleDraft(() => client.listNamedAgentProfiles.mock.calls.length === 1);
    await act(async () => {
      state.setAgentProfile('alpha-only');
    });
    state = await settleDraft((value) => value.agentProfile === 'alpha-only');
    await act(async () => {
      state.setCwd('/workspace/custom');
    });
    state = await settleDraft((value) =>
      value.agentProfileCatalogMode.mode === 'disabled'
      && !value.agentProfileCatalogPending
      && value.agentProfile === 'agent'
      && value.modelOverride === undefined
    );
    await act(async () => {
      state.setAgentProfile('beta-only');
    });
    const body = await sentBody(state);

    expect(client.listNamedAgentProfiles.mock.calls.map(([workspaceId]) => workspaceId)).toEqual([
      'wd_alpha',
    ]);
    expect(client.listNamedAgentProfiles).not.toHaveBeenCalledWith(undefined);
    expect(body).toMatchObject({
      metadata: { cwd: '/workspace/custom' },
      agent_config: { profile: 'agent' },
    });
    expect(body.agent_config?.model).toBeUndefined();
    expect(body.agent_config?.thinking).toBeUndefined();
  });
});

describe('resolveSelectedEffort', () => {
  it('submits the same catalog default that the untouched select displays', () => {
    expect(resolveSelectedEffort(['low', 'medium', 'high'], undefined, 'medium')).toBe('medium');
  });

  it('falls back to the first visible option and preserves a supported explicit selection', () => {
    expect(resolveSelectedEffort(['low', 'high'], undefined, undefined)).toBe('low');
    expect(resolveSelectedEffort(['low', 'high'], 'high', 'low')).toBe('high');
    expect(resolveSelectedEffort(['low', 'high'], 'stale', 'missing')).toBe('low');
  });

  it('omits thinking when the effective model has no effort selector', () => {
    expect(resolveSelectedEffort(undefined, 'high', 'medium')).toBeUndefined();
    expect(resolveSelectedEffort([], 'high', 'medium')).toBeUndefined();
  });
});

describe('buildAgentProfileOptions', () => {
  const profile = (overrides: Partial<NamedAgentProfile>): NamedAgentProfile => ({
    name: 'agent',
    source: 'builtin',
    main: false,
    disabled: false,
    routes: [],
    ...overrides,
  });

  it('lists only main profiles, without any main suffix or badge', () => {
    const options = buildAgentProfileOptions([
      profile({ name: 'agent', main: true, description: 'General-purpose.' }),
      profile({ name: 'grok-only', source: 'user', main: true }),
      // Subagent profiles are dispatch targets, not conversation partners —
      // they never appear in the picker, even while enabled.
      profile({ name: 'reviewer', source: 'workspace' }),
      profile({ name: 'legacy', disabled: true }),
    ]);
    expect(options.map((option) => option.value)).toEqual(['agent', 'grok-only']);
    expect(options[0]?.label).toBe('agent');
    expect(options[0]?.hint).toBe('General-purpose.');
    expect(options[1]?.label).toBe('grok-only');
  });

  it('keeps a disabled main profile selectable', () => {
    // Turning a main profile off only stops subagent calls, so the picker
    // must keep offering it for main sessions.
    const options = buildAgentProfileOptions([
      profile({ name: 'suspended-main', main: true, disabled: true }),
    ]);
    expect(options.map((option) => option.value)).toEqual(['suspended-main']);
    expect(options[0]?.label).toBe('suspended-main');
  });

  it('never promotes a private scoped subagent lease to a selectable profile', () => {
    // Dedicated subagents live only inside a parent profile's `subagents`
    // lease list — they are not public catalog entries, so even a parent
    // carrying a `scope: 'private'` lease yields no option for the child.
    const options = buildAgentProfileOptions([
      profile({
        name: 'agent',
        main: true,
        subagents: [
          'reviewer',
          {
            name: 'writer',
            source: './_private/research/writer.md',
            scope: 'private',
            status: 'ready',
          },
        ],
      }),
    ]);
    expect(options.map((option) => option.value)).toEqual(['agent']);
  });
});

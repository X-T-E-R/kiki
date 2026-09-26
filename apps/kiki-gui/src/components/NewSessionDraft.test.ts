// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionCreate } from '@kiki/protocol';

import { I18nProvider } from '../i18n';
import type { NamedAgentProfile } from '../lib/client';
import { buildAgentProfileOptions, resolveSelectedEffort } from './Composer';
import {
  AUTO_WORKSPACE_ID,
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
const queryClients: QueryClient[] = [];
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
  await unmountDraft();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

function DraftHarness(props: { initialWorkspaceId?: string; initialProfile?: string; prefillNavigationKey?: string }) {
  latestDraftState = useNewSessionDraft(props);
  return null;
}

async function renderDraft(
  props: { initialWorkspaceId?: string; initialProfile?: string; prefillNavigationKey?: string } = {},
): Promise<QueryClient> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.push(queryClient);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(I18nProvider, null, createElement(DraftHarness, props)),
      ),
    );
  });
  return queryClient;
}

async function unmountDraft(): Promise<void> {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
  for (const container of containers.splice(0)) container.remove();
  latestDraftState = undefined;
}

function readStoredDraft(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem('kiki.newSessionDraft') ?? '{}') as Record<string, unknown>;
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
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

  it('omits workspace_id and metadata.cwd for automatic allocation', () => {
    const body = buildNewSessionCreate({
      cwd: '',
      profile: 'agent',
      permissionMode: 'manual',
      planMode: false,
      swarmMode: false,
    });
    expect(body.workspace_id).toBeUndefined();
    expect(body.metadata).toBeUndefined();
    expect(body.agent_config).toMatchObject({ profile: 'agent' });
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
  const model = (id: string, effort: string) => ({
    id,
    provider_id: 'fixture',
    remote_id: id.slice(id.lastIndexOf('/') + 1),
    max_context_size: 128000,
    support_efforts: [effort],
    default_effort: effort,
  });
  const sentBody = async (state: NewSessionDraftState): Promise<SessionCreate> => {
    await act(async () => {
      void state.send('Start work', []);
    });
    await settleDraft(() => client.createSession.mock.calls.length > 0);
    return client.createSession.mock.calls.at(-1)?.[0] as SessionCreate;
  };

  it('uses unscoped profiles and creates without a target on first run', async () => {
    const catalog = deferred<{ items: NamedAgentProfile[] }>();
    client.listNamedAgentProfiles.mockReturnValue(catalog.promise);

    await renderDraft();
    let state = await settleDraft((value) =>
      value.agentProfileCatalogPending && client.listNamedAgentProfiles.mock.calls.length === 1
    );
    expect(state.autoWorkspace).toBe(true);
    expect(state.agentProfileCatalogMode).toEqual({ mode: 'unscoped' });
    await act(async () => { void state.send('Wait for the profile catalog', []); });
    expect(client.createSession).not.toHaveBeenCalled();

    catalog.resolve({ items: [profile('agent')] });
    state = await settleDraft((value) => !value.agentProfileCatalogPending);
    expect(client.listNamedAgentProfiles).toHaveBeenCalledWith();
    const body = await sentBody(state);
    expect(body.workspace_id).toBeUndefined();
    expect(body.metadata).toBeUndefined();
    expect(body.agent_config?.profile).toBe('agent');
  });

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
      void state.send('Too early', []);
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

    expect(client.listNamedAgentProfiles).toHaveBeenCalledWith({
      workspace_id: 'wd_alpha',
      effective: true,
    });
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

  it.each(['missing-main', 'workspace-helper', 'disabled-main'])(
    'preserves invalid initial profile %s until an enabled main is explicitly selected',
    async (initialProfile) => {
      client.listWorkspaces.mockResolvedValue({ items: [workspace('wd_beta', 'Beta')] });
      client.listModels.mockResolvedValue({ items: [model('provider/beta', 'high')] });
      client.listNamedAgentProfiles.mockResolvedValue({
        items: [
          profile('agent'),
          profile('workspace-main', 'provider/beta', 'high'),
          profile('workspace-helper', 'provider/beta', 'high', false),
          { ...profile('disabled-main', 'provider/beta', 'high'), disabled: true },
        ],
      });

      await renderDraft({ initialWorkspaceId: 'wd_beta', initialProfile });
      let state = await settleDraft((value) => !value.agentProfileCatalogPending);

      expect(client.listNamedAgentProfiles).toHaveBeenCalledWith({
        workspace_id: 'wd_beta',
        effective: true,
      });
      expect(state.agentProfile).toBe(initialProfile);
      expect(state.modelOverride).toBeUndefined();
      expect(readStoredDraft()).toMatchObject({ profile: initialProfile });
      await act(async () => {
        void state.send('Do not silently use agent', []);
      });
      expect(client.createSession).not.toHaveBeenCalled();

      await act(async () => {
        state.setAgentProfile('workspace-main');
      });
      state = await settleDraft((value) =>
        value.agentProfile === 'workspace-main'
        && value.modelOverride === 'provider/beta'
        && value.effectiveEffort === 'high'
      );
      expect(await sentBody(state)).toMatchObject({
        workspace_id: 'wd_beta',
        agent_config: { profile: 'workspace-main', model: 'provider/beta', thinking: 'high' },
      });
    },
  );

  it('ends pending after a catalog error but keeps the initial selection blocked until retry succeeds', async () => {
    const catalog = deferred<{ items: NamedAgentProfile[] }>();
    client.listWorkspaces.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha')] });
    client.listModels.mockResolvedValue({ items: [model('provider/alpha', 'high')] });
    client.listNamedAgentProfiles.mockReturnValue(catalog.promise);

    const queryClient = await renderDraft({ initialWorkspaceId: 'wd_alpha', initialProfile: 'workspace-main' });
    let state = await settleDraft((value) =>
      value.agentProfileCatalogPending && client.listNamedAgentProfiles.mock.calls.length === 1
    );
    await act(async () => {
      void state.send('Still validating', []);
      catalog.reject(new Error('catalog unavailable'));
    });
    state = await settleDraft((value) => !value.agentProfileCatalogPending);
    expect(state.agentProfile).toBe('workspace-main');
    expect(state.modelOverride).toBeUndefined();
    expect(readStoredDraft()).toMatchObject({
      profile: 'workspace-main', modelFromProfile: true, effortFromProfile: true,
    });
    await act(async () => {
      void state.send('An error is not permission to fall back', []);
    });
    expect(client.createSession).not.toHaveBeenCalled();

    const retry = deferred<{ items: NamedAgentProfile[] }>();
    client.listNamedAgentProfiles.mockReturnValue(retry.promise);
    await act(async () => {
      void queryClient.refetchQueries({ queryKey: ['agentProfiles'] });
    });
    state = await settleDraft((value) =>
      value.agentProfileCatalogPending && client.listNamedAgentProfiles.mock.calls.length === 2
    );
    await act(async () => {
      void state.send('Retry is still pending', []);
    });
    expect(client.createSession).not.toHaveBeenCalled();
    retry.resolve({
      items: [profile('agent'), profile('workspace-main', 'provider/alpha', 'high')],
    });
    state = await settleDraft((value) =>
      !value.agentProfileCatalogPending
      && value.modelOverride === 'provider/alpha'
      && value.effectiveEffort === 'high'
    );
    expect(client.createSession).not.toHaveBeenCalled();
    expect(client.listNamedAgentProfiles.mock.calls).toEqual([
      [{ workspace_id: 'wd_alpha', effective: true }],
      [{ workspace_id: 'wd_alpha', effective: true }],
    ]);
    expect(await sentBody(state)).toMatchObject({
      workspace_id: 'wd_alpha',
      agent_config: { profile: 'workspace-main', model: 'provider/alpha', thinking: 'high' },
    });
  });

  it('preserves selection and pins after a workspace catalog error until a valid workspace is reselected', async () => {
    const nextCatalog = deferred<{ items: NamedAgentProfile[] }>();
    client.listWorkspaces.mockResolvedValue({
      items: [workspace('wd_alpha', 'Alpha'), workspace('wd_beta', 'Beta')],
    });
    client.listModels.mockResolvedValue({ items: [model('provider/alpha', 'low')] });
    client.listNamedAgentProfiles
      .mockResolvedValueOnce({
        items: [profile('agent'), profile('alpha-only', 'provider/alpha', 'low')],
      })
      .mockReturnValueOnce(nextCatalog.promise);

    await renderDraft({ initialWorkspaceId: 'wd_alpha' });
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);
    await act(async () => {
      state.setAgentProfile('alpha-only');
    });
    state = await settleDraft((value) => value.modelOverride === 'provider/alpha');
    await act(async () => {
      state.selectWorkspace('wd_beta');
      void state.send('Must not use Alpha in Beta', []);
    });
    expect(client.createSession).not.toHaveBeenCalled();
    state = await settleDraft((value) =>
      value.agentProfileCatalogPending && value.effectiveWorkspace?.id === 'wd_beta'
    );
    expect(state.agentProfile).toBe('alpha-only');
    expect(state.modelOverride).toBe('provider/alpha');
    expect(state.effectiveEffort).toBe('low');
    nextCatalog.reject(new Error('catalog unavailable'));
    state = await settleDraft((value) => !value.agentProfileCatalogPending);
    expect(state.agentProfile).toBe('alpha-only');
    expect(state.modelOverride).toBe('provider/alpha');
    expect(state.effectiveEffort).toBe('low');
    expect(readStoredDraft()).toMatchObject({
      workspaceId: 'wd_beta',
      profile: 'alpha-only',
      modelOverride: 'provider/alpha',
      effortOverride: 'low',
      modelFromProfile: true,
      effortFromProfile: true,
    });
    await act(async () => {
      void state.send('A rejected catalog must still block', []);
    });
    expect(client.createSession).not.toHaveBeenCalled();

    await act(async () => {
      state.selectWorkspace('wd_alpha');
    });
    state = await settleDraft((value) =>
      !value.agentProfileCatalogPending && value.effectiveWorkspace?.id === 'wd_alpha'
    );
    expect(client.listNamedAgentProfiles.mock.calls).toEqual([
      [{ workspace_id: 'wd_alpha', effective: true }],
      [{ workspace_id: 'wd_beta', effective: true }],
    ]);
    expect(await sentBody(state)).toMatchObject({
      workspace_id: 'wd_alpha',
      agent_config: { profile: 'alpha-only', model: 'provider/alpha', thinking: 'low' },
    });
  });

  it('keeps a confirmed missing workspace profile and its pins blocked until a valid main is selected', async () => {
    client.listWorkspaces.mockResolvedValue({
      items: [workspace('wd_alpha', 'Alpha'), workspace('wd_beta', 'Beta')],
    });
    client.listModels.mockResolvedValue({
      items: [model('provider/alpha', 'low'), model('provider/beta', 'high')],
    });
    client.listNamedAgentProfiles.mockImplementation(async (query?: { workspace_id?: string; effective?: boolean }) => ({
      items: query?.workspace_id === 'wd_beta'
        ? [profile('agent'), profile('beta-only', 'provider/beta', 'high')]
        : [profile('agent'), profile('alpha-only', 'provider/alpha', 'low')],
    }));

    await renderDraft({ initialWorkspaceId: 'wd_alpha' });
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);
    await act(async () => {
      state.setAgentProfile('alpha-only');
    });
    state = await settleDraft((value) => value.modelOverride === 'provider/alpha');
    await act(async () => {
      state.selectWorkspace('wd_beta');
      void state.send('Must not use Alpha', []);
    });
    expect(client.createSession).not.toHaveBeenCalled();
    state = await settleDraft((value) =>
      !value.agentProfileCatalogPending && value.effectiveWorkspace?.id === 'wd_beta'
    );
    expect(state.agentProfile).toBe('alpha-only');
    expect(state.modelOverride).toBe('provider/alpha');
    expect(state.effectiveEffort).toBe('low');
    expect(readStoredDraft()).toMatchObject({
      workspaceId: 'wd_beta', profile: 'alpha-only', modelOverride: 'provider/alpha', effortOverride: 'low',
    });
    await act(async () => {
      void state.send('Do not silently use agent', []);
    });
    expect(client.createSession).not.toHaveBeenCalled();

    await act(async () => {
      state.setAgentProfile('beta-only');
    });
    state = await settleDraft((value) =>
      value.agentProfile === 'beta-only'
      && value.modelOverride === 'provider/beta'
      && value.effectiveEffort === 'high'
    );
    expect(await sentBody(state)).toMatchObject({
      workspace_id: 'wd_beta',
      agent_config: { profile: 'beta-only', model: 'provider/beta', thinking: 'high' },
    });
  });

  it('reapplies the next workspace definition to profile-derived pins after remount', async () => {
    client.listWorkspaces.mockResolvedValue({
      items: [workspace('wd_alpha', 'Alpha'), workspace('wd_beta', 'Beta')],
    });
    client.listModels.mockResolvedValue({
      items: [model('provider/alpha', 'low'), model('provider/beta', 'high')],
    });
    client.listNamedAgentProfiles.mockImplementation(async (query?: { workspace_id?: string; effective?: boolean }) => ({
      items: query?.workspace_id === 'wd_beta'
        ? [profile('agent'), profile('workspace-choice', 'provider/beta', 'high')]
        : [profile('agent'), profile('workspace-choice', 'provider/alpha', 'low')],
    }));

    await renderDraft({ initialWorkspaceId: 'wd_alpha' });
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);
    await act(async () => {
      state.setAgentProfile('workspace-choice');
    });
    state = await settleDraft((value) =>
      value.modelOverride === 'provider/alpha' && value.effectiveEffort === 'low'
    );
    expect(readStoredDraft()).toMatchObject({ modelFromProfile: true, effortFromProfile: true });
    const stored = localStorage.getItem('kiki.newSessionDraft');
    await unmountDraft();
    expect(localStorage.getItem('kiki.newSessionDraft')).toBe(stored);

    await renderDraft();
    state = await settleDraft((value) => !value.agentProfileCatalogPending);
    expect(state.agentProfile).toBe('workspace-choice');
    expect(state.modelOverride).toBe('provider/alpha');
    expect(state.effectiveEffort).toBe('low');
    await act(async () => {
      state.selectWorkspace('wd_beta');
      void state.send('Must not use Alpha pins', []);
    });
    expect(client.createSession).not.toHaveBeenCalled();
    state = await settleDraft((value) =>
      !value.agentProfileCatalogPending && value.effectiveWorkspace?.id === 'wd_beta'
    );
    expect(state.agentProfile).toBe('workspace-choice');
    expect(state.modelOverride).toBe('provider/beta');
    expect(state.effectiveEffort).toBe('high');
    expect(readStoredDraft()).toMatchObject({
      modelOverride: 'provider/beta',
      effortOverride: 'high',
      modelFromProfile: true,
      effortFromProfile: true,
    });
    expect(client.listNamedAgentProfiles.mock.calls).toEqual([
      [{ workspace_id: 'wd_alpha', effective: true }],
      [{ workspace_id: 'wd_alpha', effective: true }],
      [{ workspace_id: 'wd_beta', effective: true }],
    ]);
    expect(await sentBody(state)).toMatchObject({
      workspace_id: 'wd_beta',
      agent_config: { profile: 'workspace-choice', model: 'provider/beta', thinking: 'high' },
    });
  });

  it('restores profile-derived pins from localStorage and sends only after the remounted catalog resolves', async () => {
    const items = [profile('agent'), profile('workspace-choice', 'provider/alpha', 'low')];
    client.listWorkspaces.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha')] });
    client.listModels.mockResolvedValue({ items: [model('provider/alpha', 'low')] });
    client.listNamedAgentProfiles.mockResolvedValue({ items });

    await renderDraft({ initialWorkspaceId: 'wd_alpha' });
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);
    await act(async () => {
      state.setAgentProfile('workspace-choice');
    });
    state = await settleDraft((value) =>
      value.modelOverride === 'provider/alpha' && value.effectiveEffort === 'low'
    );
    expect(readStoredDraft()).toEqual({
      prefillSource: JSON.stringify(['wd_alpha', null, null]),
      workspaceId: 'wd_alpha',
      cwd: '',
      profile: 'workspace-choice',
      modelOverride: 'provider/alpha',
      effortOverride: 'low',
      modelFromProfile: true,
      effortFromProfile: true,
    });
    const stored = localStorage.getItem('kiki.newSessionDraft');
    await unmountDraft();
    expect(localStorage.getItem('kiki.newSessionDraft')).toBe(stored);

    const catalog = deferred<{ items: NamedAgentProfile[] }>();
    client.listNamedAgentProfiles.mockReturnValue(catalog.promise);
    await renderDraft();
    state = await settleDraft((value) =>
      value.agentProfileCatalogPending && client.listNamedAgentProfiles.mock.calls.length === 2
    );
    expect(state.workspaceId).toBe('wd_alpha');
    expect(state.agentProfile).toBe('workspace-choice');
    expect(state.modelOverride).toBe('provider/alpha');
    expect(state.effectiveEffort).toBe('low');
    await act(async () => {
      void state.send('Restored pins are not yet validated', []);
    });
    expect(client.createSession).not.toHaveBeenCalled();

    catalog.resolve({ items });
    state = await settleDraft((value) => !value.agentProfileCatalogPending);
    expect(client.createSession).not.toHaveBeenCalled();
    expect(client.listNamedAgentProfiles.mock.calls).toEqual([
      [{ workspace_id: 'wd_alpha', effective: true }],
      [{ workspace_id: 'wd_alpha', effective: true }],
    ]);
    expect(await sentBody(state)).toMatchObject({
      workspace_id: 'wd_alpha',
      agent_config: { profile: 'workspace-choice', model: 'provider/alpha', thinking: 'low' },
    });
  });

  it.each([
    { label: 'different-valued', selectedModel: 'provider/manual', selectedEffort: 'medium' },
    { label: 'same-valued', selectedModel: 'provider/alpha', selectedEffort: 'low' },
  ])('persists $label manual overrides through remount and a same-name workspace profile refresh', async ({ selectedModel, selectedEffort }) => {
    client.listWorkspaces.mockResolvedValue({
      items: [workspace('wd_alpha', 'Alpha'), workspace('wd_beta', 'Beta')],
    });
    client.listModels.mockResolvedValue({
      items: [
        model('provider/alpha', 'low'),
        model('provider/beta', 'high'),
        model('provider/manual', 'medium'),
      ],
    });
    client.listNamedAgentProfiles.mockImplementation(async (query?: { workspace_id?: string; effective?: boolean }) => ({
      items: query?.workspace_id === 'wd_beta'
        ? [profile('agent'), profile('workspace-choice', 'provider/beta', 'high')]
        : [profile('agent'), profile('workspace-choice', 'provider/alpha', 'low')],
    }));

    const prefill = { initialWorkspaceId: 'wd_alpha', initialProfile: 'workspace-choice', prefillNavigationKey: 'entry-a' };
    await renderDraft(prefill);
    let state = await settleDraft((value) => !value.agentProfileCatalogPending && value.modelOverride === 'provider/alpha');
    await act(async () => {
      state.setModelOverride(selectedModel);
      state.setEffortOverride(selectedEffort);
    });
    state = await settleDraft((value) =>
      value.modelOverride === selectedModel && value.effectiveEffort === selectedEffort
    );
    expect(readStoredDraft()).toMatchObject({
      profile: 'workspace-choice',
      modelOverride: selectedModel,
      effortOverride: selectedEffort,
      modelFromProfile: false,
      effortFromProfile: false,
    });
    const stored = localStorage.getItem('kiki.newSessionDraft');
    await unmountDraft();
    expect(localStorage.getItem('kiki.newSessionDraft')).toBe(stored);

    await renderDraft(prefill);
    state = await settleDraft((value) => !value.agentProfileCatalogPending);
    expect(state.agentProfile).toBe('workspace-choice');
    expect(state.modelOverride).toBe(selectedModel);
    expect(state.effectiveEffort).toBe(selectedEffort);
    await act(async () => {
      state.selectWorkspace('wd_beta');
      void state.send('Do not send during the workspace transition', []);
    });
    expect(client.createSession).not.toHaveBeenCalled();
    state = await settleDraft((value) =>
      !value.agentProfileCatalogPending && value.effectiveWorkspace?.id === 'wd_beta'
    );
    expect(state.agentProfile).toBe('workspace-choice');
    expect(state.modelOverride).toBe(selectedModel);
    expect(state.effectiveEffort).toBe(selectedEffort);
    expect(readStoredDraft()).toMatchObject({
      workspaceId: 'wd_beta',
      modelOverride: selectedModel,
      effortOverride: selectedEffort,
      modelFromProfile: false,
      effortFromProfile: false,
    });
    expect(await sentBody(state)).toMatchObject({
      workspace_id: 'wd_beta',
      agent_config: { profile: 'workspace-choice', model: selectedModel, thinking: selectedEffort },
    });
  });

  it.each(['workspace', 'cwd'])('does not replay an old prefill over edited %s/profile/manual choices on remount', async (target) => {
    client.listWorkspaces.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha'), workspace('wd_beta', 'Beta')] });
    client.listModels.mockResolvedValue({ items: [model('provider/alpha', 'low'), model('provider/beta', 'high')] });
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent'), profile('profile-p', 'provider/alpha', 'low'), profile('profile-q', 'provider/beta', 'high')] });
    const prefill = { initialWorkspaceId: 'wd_alpha', initialProfile: 'profile-p', prefillNavigationKey: 'entry-a' };
    await renderDraft(prefill);
    let state = await settleDraft((value) => !value.agentProfileCatalogPending && value.modelOverride === 'provider/alpha');
    await act(async () => {
      if (target === 'workspace') state.selectWorkspace('wd_beta');
      else state.setCwd('/workspace/custom');
    });
    state = await settleDraft((value) => !value.agentProfileCatalogPending);
    await act(async () => { state.setAgentProfile('profile-q'); });
    state = await settleDraft((value) => value.modelOverride === 'provider/beta');
    await act(async () => {
      state.setModelOverride('provider/beta');
      state.setEffortOverride('high');
    });
    const saved = readStoredDraft();
    expect(saved).toMatchObject({ profile: 'profile-q', modelFromProfile: false, effortFromProfile: false });
    await unmountDraft();
    client.listNamedAgentProfiles.mockClear();
    await renderDraft(prefill);
    state = await settleDraft((value) => !value.agentProfileCatalogPending);
    expect(readStoredDraft()).toEqual(saved);
    expect(state.agentProfile).toBe('profile-q');
    expect(state.modelOverride).toBe('provider/beta');
    expect(state.effectiveEffort).toBe('high');
    expect(client.listNamedAgentProfiles).toHaveBeenCalledWith(target === 'workspace'
      ? { workspace_id: 'wd_beta', effective: true }
      : { cwd: '/workspace/custom', effective: true });
    const body = await sentBody(state);
    expect(body.agent_config).toMatchObject({ profile: 'profile-q', model: 'provider/beta', thinking: 'high' });
    if (target === 'workspace') expect(body.workspace_id).toBe('wd_beta');
    else expect(body.metadata?.cwd).toBe('/workspace/custom');
  });

  it('applies a different deep link and a new navigation to the same deep link instead of permanently preferring saved choices', async () => {
    client.listWorkspaces.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha'), workspace('wd_beta', 'Beta')] });
    client.listModels.mockResolvedValue({ items: [model('provider/alpha', 'low'), model('provider/beta', 'high')] });
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent'), profile('profile-p', 'provider/alpha', 'low'), profile('profile-q', 'provider/beta', 'high')] });
    const first = { initialWorkspaceId: 'wd_alpha', initialProfile: 'profile-p', prefillNavigationKey: 'entry-a' };
    await renderDraft(first);
    let state = await settleDraft((value) => !value.agentProfileCatalogPending && value.modelOverride === 'provider/alpha');
    await act(async () => { state.setCwd('/workspace/custom'); state.setAgentProfile('profile-q'); });
    await settleDraft((value) => !value.agentProfileCatalogPending && value.agentProfile === 'profile-q');
    await unmountDraft();
    await renderDraft({ ...first, prefillNavigationKey: 'entry-b' });
    state = await settleDraft((value) => !value.agentProfileCatalogPending && value.modelOverride === 'provider/alpha');
    expect(state.workspaceId).toBe('wd_alpha');
    expect(state.cwd).toBe('');
    expect(state.agentProfile).toBe('profile-p');
    await unmountDraft();
    await renderDraft({ initialWorkspaceId: 'wd_beta', initialProfile: 'profile-q', prefillNavigationKey: 'entry-c' });
    state = await settleDraft((value) => !value.agentProfileCatalogPending && value.modelOverride === 'provider/beta');
    expect(state.workspaceId).toBe('wd_beta');
    expect(state.agentProfile).toBe('profile-q');
    expect(readStoredDraft()).toMatchObject({ modelFromProfile: true, effortFromProfile: true });
  });

  it('queries an effective cwd catalog and allows selecting its main profile without using workspace pins', async () => {
    const catalog = deferred<{ items: NamedAgentProfile[] }>();
    client.listWorkspaces.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha')] });
    client.listModels.mockResolvedValue({
      items: [model('provider/alpha', 'low'), model('provider/custom', 'high')],
    });
    client.listNamedAgentProfiles.mockImplementation((query?: { workspace_id?: string; cwd?: string; effective?: boolean }) =>
      query?.cwd === '/workspace/custom'
        ? catalog.promise
        : Promise.resolve({ items: [profile('agent'), profile('alpha-only', 'provider/alpha', 'low')] })
    );

    await renderDraft({ initialWorkspaceId: 'wd_alpha' });
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);
    await act(async () => {
      state.setAgentProfile('alpha-only');
    });
    state = await settleDraft((value) => value.modelOverride === 'provider/alpha');
    await act(async () => {
      state.setCwd(' /workspace/custom ');
      void state.send('Do not use the old workspace catalog', []);
    });
    expect(client.createSession).not.toHaveBeenCalled();
    state = await settleDraft((value) =>
      value.agentProfileCatalogMode.mode === 'cwd' && value.agentProfileCatalogPending
    );
    await act(async () => {
      void state.send('The directory catalog is still pending', []);
    });
    expect(client.createSession).not.toHaveBeenCalled();
    catalog.resolve({ items: [profile('agent'), profile('directory-main', 'provider/custom', 'high')] });
    state = await settleDraft((value) => !value.agentProfileCatalogPending);
    expect(state.agentProfileCatalogMode).toEqual({ mode: 'cwd', cwd: '/workspace/custom', effective: true });
    expect(state.agentProfile).toBe('alpha-only');
    expect(state.modelOverride).toBe('provider/alpha');
    await act(async () => {
      void state.send('An absent directory profile must not fall back', []);
    });
    expect(client.createSession).not.toHaveBeenCalled();

    await act(async () => {
      state.setAgentProfile('directory-main');
    });
    state = await settleDraft((value) =>
      value.agentProfile === 'directory-main'
      && value.modelOverride === 'provider/custom'
      && value.effectiveEffort === 'high'
    );
    const body = await sentBody(state);
    expect(client.listNamedAgentProfiles.mock.calls).toEqual([
      [{ workspace_id: 'wd_alpha', effective: true }],
      [{ cwd: '/workspace/custom', effective: true }],
    ]);
    expect(body).toMatchObject({
      metadata: { cwd: '/workspace/custom' },
      agent_config: { profile: 'directory-main', model: 'provider/custom', thinking: 'high' },
    });
    expect(body.workspace_id).toBeUndefined();
  });

  it('keeps a deleted model selected after remount and blocks creation until a valid model is chosen', async () => {
    client.listWorkspaces.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha')] });
    client.listModels.mockResolvedValue({
      items: [model('provider/removed', 'low'), model('provider/available', 'high')],
    });
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent')] });

    await renderDraft({ initialWorkspaceId: 'wd_alpha' });
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);
    await act(async () => {
      state.setModelOverride('provider/removed');
      state.setEffortOverride('low');
    });
    state = await settleDraft((value) => value.modelOverride === 'provider/removed');
    const stored = localStorage.getItem('kiki.newSessionDraft');
    await unmountDraft();
    expect(localStorage.getItem('kiki.newSessionDraft')).toBe(stored);

    client.getConfig.mockResolvedValue({ default_model: 'provider/available' });
    client.listModels.mockResolvedValue({ items: [model('provider/available', 'high')] });
    const queryClient = await renderDraft();
    state = await settleDraft((value) =>
      !value.agentProfileCatalogPending && queryClient.getQueryState(['models'])?.status === 'success'
    );
    expect(state.modelOverride).toBe('provider/removed');
    expect(state.effectiveEffort).toBe('low');
    expect(readStoredDraft()).toMatchObject({ modelOverride: 'provider/removed', effortOverride: 'low' });
    await act(async () => {
      void state.send('Do not silently substitute the default model', []);
    });
    expect(client.createSession).not.toHaveBeenCalled();

    await act(async () => {
      state.setModelOverride('provider/available');
      state.setEffortOverride('high');
    });
    state = await settleDraft((value) =>
      value.modelOverride === 'provider/available' && value.effectiveEffort === 'high'
    );
    expect(await sentBody(state)).toMatchObject({
      workspace_id: 'wd_alpha',
      agent_config: { profile: 'agent', model: 'provider/available', thinking: 'high' },
    });
  });

  it('retains an explicit automatic choice across remount and excludes workspace-only profiles', async () => {
    client.listWorkspaces.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha')] });
    client.listModels.mockResolvedValue({ items: [model('provider/alpha', 'low')] });
    client.listNamedAgentProfiles.mockResolvedValue({
      items: [
        profile('agent'),
        { ...profile('workspace-choice', 'provider/alpha', 'low'), workspace_id: 'wd_alpha' },
      ],
    });

    await renderDraft({ initialWorkspaceId: 'wd_alpha' });
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);
    await act(async () => { state.setAgentProfile('workspace-choice'); });
    state = await settleDraft((value) => value.modelOverride === 'provider/alpha');
    await act(async () => {
      state.selectWorkspace(AUTO_WORKSPACE_ID);
      void state.send('Do not use the old workspace catalog', []);
    });
    expect(client.createSession).not.toHaveBeenCalled();
    state = await settleDraft((value) =>
      !value.agentProfileCatalogPending && value.agentProfileCatalogMode.mode === 'unscoped'
    );
    expect(state.autoWorkspace).toBe(true);
    expect(state.effectiveWorkspace).toBeUndefined();
    expect(readStoredDraft()).toMatchObject({ workspaceId: AUTO_WORKSPACE_ID });
    await act(async () => { void state.send('A workspace-only profile is not available', []); });
    expect(client.createSession).not.toHaveBeenCalled();

    await unmountDraft();
    await renderDraft();
    state = await settleDraft((value) => !value.agentProfileCatalogPending && !value.workspacesLoading);
    expect(state.workspaceId).toBe(AUTO_WORKSPACE_ID);
    expect(state.autoWorkspace).toBe(true);
    expect(state.agentProfile).toBe('workspace-choice');
    expect(client.listNamedAgentProfiles.mock.calls.at(-1)).toEqual([]);
    await act(async () => { state.setAgentProfile('agent'); });
    state = await settleDraft((value) => value.agentProfile === 'agent' && value.modelOverride === undefined);
    const body = await sentBody(state);
    expect(body.workspace_id).toBeUndefined();
    expect(body.metadata).toBeUndefined();
  });

  it('keeps a deleted workspace id after remount instead of falling back to another workspace', async () => {
    client.listWorkspaces.mockResolvedValue({
      items: [workspace('wd_alpha', 'Alpha'), workspace('wd_beta', 'Beta')],
    });
    client.listModels.mockResolvedValue({
      items: [model('provider/alpha', 'low'), model('provider/beta', 'high')],
    });
    client.listNamedAgentProfiles.mockImplementation(async (query?: { workspace_id?: string; effective?: boolean }) => ({
      items: query?.workspace_id === 'wd_beta'
        ? [profile('agent'), profile('workspace-choice', 'provider/beta', 'high')]
        : [profile('agent'), profile('workspace-choice', 'provider/alpha', 'low')],
    }));

    await renderDraft({ initialWorkspaceId: 'wd_alpha' });
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);
    await act(async () => {
      state.setAgentProfile('workspace-choice');
    });
    state = await settleDraft((value) => value.modelOverride === 'provider/alpha');
    const stored = localStorage.getItem('kiki.newSessionDraft');
    await unmountDraft();
    expect(localStorage.getItem('kiki.newSessionDraft')).toBe(stored);

    client.listWorkspaces.mockResolvedValue({ items: [workspace('wd_beta', 'Beta')] });
    await renderDraft();
    state = await settleDraft((value) => !value.workspacesLoading && !value.agentProfileCatalogPending);
    expect(state.workspaceId).toBe('wd_alpha');
    expect(state.effectiveWorkspace).toBeUndefined();
    expect(state.autoWorkspace).toBe(false);
    expect(state.agentProfileCatalogMode).toEqual({ mode: 'disabled' });
    expect(state.agentProfile).toBe('workspace-choice');
    expect(state.modelOverride).toBe('provider/alpha');
    expect(state.effectiveEffort).toBe('low');
    expect(readStoredDraft()).toMatchObject({ workspaceId: 'wd_alpha' });
    expect(client.listNamedAgentProfiles.mock.calls).toEqual([
      [{ workspace_id: 'wd_alpha', effective: true }],
    ]);
    await act(async () => {
      void state.send('A deleted workspace must not become Beta', []);
    });
    expect(client.createSession).not.toHaveBeenCalled();

    await act(async () => {
      state.selectWorkspace('wd_beta');
    });
    state = await settleDraft((value) =>
      !value.agentProfileCatalogPending
      && value.effectiveWorkspace?.id === 'wd_beta'
      && value.modelOverride === 'provider/beta'
      && value.effectiveEffort === 'high'
    );
    expect(await sentBody(state)).toMatchObject({
      workspace_id: 'wd_beta',
      agent_config: { profile: 'workspace-choice', model: 'provider/beta', thinking: 'high' },
    });
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
  const t = (key: string, params?: Record<string, string | number>) =>
    params !== undefined ? `${key}:${Object.values(params).join(',')}` : key;
  const profile = (overrides: Partial<NamedAgentProfile>): NamedAgentProfile => ({
    name: 'agent',
    source: 'builtin',
    main: false,
    disabled: false,
    routes: [],
    ...overrides,
  });

  it('lists only enabled main profiles in catalog order', () => {
    const options = buildAgentProfileOptions(
      [
        profile({ name: 'agent', main: true, description: 'General-purpose.' }),
        profile({ name: 'reviewer', source: 'workspace', description: 'Reviews code.' }),
        profile({ name: 'grok-only', source: 'user', main: true }),
        profile({ name: 'legacy', disabled: true }),
        profile({ name: 'suspended-main', main: true, disabled: true }),
      ],
      t,
    );
    // Only enabled main profiles are pickable; non-main and disabled ones drop out.
    expect(options.map((option) => option.value)).toEqual(['agent', 'grok-only']);
    expect(options[0]?.label).toBe('agent');
    expect(options[0]?.description).toBe('General-purpose.');
    expect(options[0]?.group).toBe('composer.profileGroupMain');
    expect(options[1]?.group).toBe('composer.profileGroupMain');
    expect(options).toHaveLength(2);
  });

  it('carries the bound model, effort, and source as row facts', () => {
    const options = buildAgentProfileOptions(
      [
        profile({
          name: 'researcher',
          source: 'user',
          main: true,
          pinned_model_alias: 'k3-256k',
          thinking_effort: 'high',
          when_to_use: 'Use for deep research tasks.',
        }),
      ],
      t,
    );
    expect(options[0]?.hint).toBe('k3-256k');
    expect(options[0]?.description).toBe('Use for deep research tasks.');
    expect(options[0]?.badges).toEqual([
      { label: 'user' },
      { label: 'composer.profileEffortBadge:high' },
    ]);
  });

  it('does not offer a disabled main profile as a fallback option', () => {
    const options = buildAgentProfileOptions(
      [profile({ name: 'suspended-main', main: true, disabled: true })],
      t,
    );
    expect(options).toEqual([]);
  });

  it('excludes profiles the wire marks private', () => {
    // Private profiles hide from public enumeration but resolve by name, so a
    // bound session keeps its trigger label while the picker skips the row.
    const options = buildAgentProfileOptions(
      [
        profile({ name: 'agent', main: true }),
        { ...profile({ name: 'internal', main: true }), private: true } as NamedAgentProfile,
      ],
      t,
    );
    expect(options.map((option) => option.value)).toEqual(['agent']);
  });

  it('never promotes a private scoped subagent lease to a selectable profile', () => {
    // Dedicated subagents live only inside a parent profile's `subagents`
    // lease list — they are not public catalog entries, so even a parent
    // carrying a `scope: 'private'` lease yields no option for the child.
    const options = buildAgentProfileOptions(
      [
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
      ],
      t,
    );
    expect(options.map((option) => option.value)).toEqual(['agent']);
  });
});

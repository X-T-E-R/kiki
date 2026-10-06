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
  isAbsoluteRemoteCwdPath,
  useNewSessionDraft,
  type NewSessionDraftState,
} from './NewSessionDraft';

const { client, navigate, scope } = vi.hoisted(() => ({
  scope: { id: 'local', label: null as string | null },
  client: {
    listWorkspaces: vi.fn(),
    klient: { rest: { workspaces: { inspect: vi.fn() }, ssh: { addSessionHost: vi.fn() } } },
    getConfig: vi.fn(),
    listModels: vi.fn(),
    listNamedAgentProfiles: vi.fn(),
    getAuth: vi.fn(),
    createSession: vi.fn(),
    getPersona: vi.fn(),
  },
  navigate: vi.fn(),
}));

vi.mock('../state/connection', () => ({
  useConnection: () => ({ client, scopeId: scope.id, sshLabel: scope.label }),
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
  scope.id = 'local';
  scope.label = null;
  latestDraftState = undefined;
  localStorage.clear();
  navigate.mockReset();
  client.listWorkspaces.mockReset().mockResolvedValue({ items: [] });
  client.klient.rest.workspaces.inspect.mockReset().mockResolvedValue({ isGit: false });
  client.getConfig.mockReset().mockResolvedValue({});
  client.listModels.mockReset().mockResolvedValue({ items: [] });
  client.listNamedAgentProfiles.mockReset().mockResolvedValue({ items: [] });
  client.getAuth.mockReset().mockResolvedValue({ ready: true });
  client.createSession.mockReset().mockResolvedValue({ id: 'session-new' });
  client.getPersona.mockReset();
});

afterEach(async () => {
  await unmountDraft();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

function DraftHarness(props: { initialWorkspaceId?: string; initialProfile?: string; initialPersona?: string; prefillNavigationKey?: string }) {
  latestDraftState = useNewSessionDraft(props);
  return null;
}

async function renderDraft(
  props: { initialWorkspaceId?: string; initialProfile?: string; initialPersona?: string; prefillNavigationKey?: string } = {},
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

  it('accepts only POSIX paths for SSH workspace cwd', () => {
    expect(isAbsoluteRemoteCwdPath('/home/dev/project')).toBe(true);
    expect(isAbsoluteRemoteCwdPath('C:/work/project')).toBe(false);
    expect(isAbsoluteRemoteCwdPath('\\\\server\\share')).toBe(false);
    expect(isAbsoluteRemoteCwdPath('/home/dev\\work')).toBe(false);
    expect(isAbsoluteRemoteCwdPath('/home/dev\0work')).toBe(false);
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
      }),
    ).toEqual({
      workspace_id: 'wd_fixture_0123456789ab',
      agent_config: {
        profile: 'agent',
        model: 'provider/model',
        thinking: 'high',
        permission_mode: 'yolo',
        plan_mode: true,
      },
    });
  });

  it('omits workspace_id and metadata.cwd for automatic allocation', () => {
    const body = buildNewSessionCreate({
      cwd: '',
      profile: 'agent',
      permissionMode: 'manual',
      planMode: false,
    });
    expect(body.workspace_id).toBeUndefined();
    expect(body.metadata).toBeUndefined();
    expect(body.agent_config).toMatchObject({ profile: 'agent' });
  });

  /**
   * A bare external engine must arrive as a bare harness. The legacy top-level
   * fields are session overrides once the execution path reads them, so
   * sending a value the user never chose would let Kiki's own default — the
   * model chip's resolved id, the app's permission mode — decide for a harness
   * that was explicitly chosen as-is.
   */
  it('sends no legacy control a bare external engine never inherited', () => {
    const body = buildNewSessionCreate({
      cwd: 'C:/repo',
      profile: 'agent',
      execution: { executor: 'claude-acp', profile: undefined, overrides: undefined },
      // What the page is displaying, none of it chosen here:
      model: 'provider/model',
      thinking: 'high',
      permissionMode: 'yolo',
      planMode: false,
      modelTouched: false,
      effortTouched: false,
      permissionTouched: false,
    });
    expect(body.agent_config).toEqual({
      execution: { executor: 'claude-acp' },
      plan_mode: false,
    });
  });

  it('keeps an explicit choice on a bare external engine', () => {
    const body = buildNewSessionCreate({
      cwd: 'C:/repo',
      profile: 'agent',
      execution: { executor: 'claude-acp', profile: undefined, overrides: undefined },
      model: 'provider/model',
      thinking: 'high',
      permissionMode: 'yolo',
      planMode: false,
      modelTouched: true,
      effortTouched: true,
      permissionTouched: true,
    });
    expect(body.agent_config).toEqual({
      execution: { executor: 'claude-acp' },
      model: 'provider/model',
      thinking: 'high',
      permission_mode: 'yolo',
      plan_mode: false,
    });
  });

  it('drops only the control that was not touched, keeping the rest explicit', () => {
    const body = buildNewSessionCreate({
      cwd: 'C:/repo',
      profile: 'agent',
      execution: { executor: 'claude-acp', profile: undefined, overrides: undefined },
      model: 'provider/model',
      thinking: 'high',
      permissionMode: 'yolo',
      planMode: false,
      modelTouched: false,
      effortTouched: true,
      permissionTouched: true,
    });
    expect(body.agent_config).toEqual({
      execution: { executor: 'claude-acp' },
      thinking: 'high',
      permission_mode: 'yolo',
      plan_mode: false,
    });
  });

  it('leaves the native engine and an external profile exactly as before', () => {
    // Native keeps every legacy field, untouched or not: that path has always
    // sent them and the server resolves them against Kiki's own defaults.
    const native = buildNewSessionCreate({
      cwd: 'C:/repo',
      profile: 'agent',
      execution: { executor: 'native', profile: 'agent', overrides: undefined },
      model: 'provider/model',
      thinking: 'high',
      permissionMode: 'auto',
      planMode: false,
      modelTouched: false,
      effortTouched: false,
      permissionTouched: false,
    });
    expect(native.agent_config).toEqual({
      profile: 'agent',
      model: 'provider/model',
      thinking: 'high',
      permission_mode: 'auto',
      plan_mode: false,
    });
    // A profile on an external engine supplies those values itself, so the
    // page must not withhold them just because the user did not touch them.
    const profiled = buildNewSessionCreate({
      cwd: 'C:/repo',
      profile: 'claude-reviewer',
      execution: { executor: 'claude-acp', profile: 'claude-reviewer', overrides: undefined },
      model: 'provider/model',
      thinking: 'high',
      permissionMode: 'auto',
      planMode: false,
      modelTouched: false,
      effortTouched: false,
      permissionTouched: false,
    });
    expect(profiled.agent_config).toEqual({
      execution: { executor: 'claude-acp', profile: 'claude-reviewer' },
      model: 'provider/model',
      thinking: 'high',
      permission_mode: 'auto',
      plan_mode: false,
    });
  });

  it('withholds only the controls the execution does not itself name', () => {
    // The real counter-example: an engine configured with a model and an
    // effort has said nothing about approvals, so the app's `manual` default
    // must not be promoted into a session override on its behalf.
    const body = buildNewSessionCreate({
      cwd: 'C:/repo',
      profile: 'agent',
      execution: {
        executor: 'example-acp',
        profile: undefined,
        overrides: { model: 'vendor-model', thinking: 'high' },
      },
      model: 'vendor-model',
      thinking: 'high',
      permissionMode: 'manual',
      planMode: false,
      modelTouched: false,
      effortTouched: false,
      permissionTouched: false,
    });
    // The execution names model and effort, so it owns both and the legacy
    // fields are not repeated; permission is unnamed and untouched, so Kiki's
    // `manual` is not promoted into an override either.
    expect(body.agent_config).toEqual({
      execution: { executor: 'example-acp', overrides: { model: 'vendor-model', thinking: 'high' } },
      plan_mode: false,
    });
    expect(body.agent_config).not.toHaveProperty('permission_mode');
  });

  it('does not let a null override revive the displayed default', () => {
    // `null` is "fall through to the next layer", not "send what is on screen".
    const body = buildNewSessionCreate({
      cwd: 'C:/repo',
      profile: 'agent',
      execution: {
        executor: 'example-acp',
        profile: undefined,
        overrides: { model: null, permission_mode: null },
      },
      model: 'vendor-model',
      thinking: 'high',
      permissionMode: 'auto',
      planMode: false,
      modelTouched: false,
      effortTouched: false,
      permissionTouched: false,
    });
    expect(body.agent_config).toEqual({
      execution: { executor: 'example-acp', overrides: { model: null, permission_mode: null } },
      // `thinking` was never named, so the effort stays with the engine.
      plan_mode: false,
    });
  });

  it('sends an approval mode on a bare engine the user actually picked', () => {
    const body = buildNewSessionCreate({
      cwd: 'C:/repo',
      profile: 'agent',
      execution: { executor: 'claude-acp', profile: undefined, overrides: undefined },
      permissionMode: 'review',
      planMode: false,
      modelTouched: false,
      effortTouched: false,
      permissionTouched: true,
    });
    expect(body.agent_config).toEqual({
      execution: { executor: 'claude-acp' },
      permission_mode: 'review',
      plan_mode: false,
    });
  });

  it('leaves a control the execution names entirely to the execution', () => {
    // The execution already carries the answer for `model`, so the legacy
    // field would be a second, conflicting statement about the same value.
    const body = buildNewSessionCreate({
      cwd: 'C:/repo',
      profile: 'agent',
      execution: {
        executor: 'claude-acp',
        profile: undefined,
        overrides: { model: 'harness-model', allow_kiki_subagents: false },
      },
      model: 'harness-model',
      thinking: 'high',
      permissionMode: 'auto',
      planMode: false,
      modelTouched: false,
      effortTouched: false,
      permissionTouched: false,
    });
    // `model` is named by the execution and `thinking` was never touched, so
    // only the untouched-and-unnamed controls are withheld; `permission_mode`
    // was never named either and the user did not pick it.
    expect(body.agent_config).toEqual({
      execution: { executor: 'claude-acp', overrides: { model: 'harness-model', allow_kiki_subagents: false } },
      plan_mode: false,
    });
  });

  it('still lets a touched control win over an engine that names no override', () => {
    const body = buildNewSessionCreate({
      cwd: 'C:/repo',
      profile: 'agent',
      execution: { executor: 'claude-acp', profile: undefined, overrides: undefined },
      model: 'picked/model',
      thinking: 'low',
      permissionMode: 'yolo',
      planMode: false,
      modelTouched: true,
      effortTouched: true,
      permissionTouched: true,
    });
    expect(body.agent_config).toEqual({
      execution: { executor: 'claude-acp' },
      model: 'picked/model',
      thinking: 'low',
      permission_mode: 'yolo',
      plan_mode: false,
    });
  });

  it('binds a persona and leaves its profile to the persona', () => {
    const body = buildNewSessionCreate({
      cwd: 'C:/repo',
      profile: 'agent',
      permissionMode: 'manual',
      planMode: false,
      persona: 'lin-lan',
    });
    expect(body).toMatchObject({ persona: 'lin-lan', metadata: { cwd: 'C:/repo' } });
    expect(body.agent_config).not.toHaveProperty('profile');
    const plain = buildNewSessionCreate({ cwd: 'C:/repo', profile: 'agent', permissionMode: 'manual', planMode: false });
    expect(plain).not.toHaveProperty('persona');
  });

  it('marks the create temporary only when asked', () => {
    const base = { profile: 'agent', permissionMode: 'manual' as const, planMode: false, cwd: '' };
    expect(buildNewSessionCreate(base).ephemeral).toBeUndefined();
    expect(buildNewSessionCreate({ ...base, ephemeral: true })).toMatchObject({ ephemeral: true });
    expect(buildNewSessionCreate({ ...base, cwd: 'C:/repo', ephemeral: true, worktree: true }))
      .toMatchObject({ metadata: { cwd: 'C:/repo' }, isolation: { kind: 'worktree' }, ephemeral: true });
  });

  it('adds worktree isolation only when explicitly requested', () => {
    const base = { profile: 'agent', permissionMode: 'manual' as const, planMode: false };
    expect(buildNewSessionCreate({ ...base, cwd: '', workspaceId: 'wd_fixture_0123456789ab' }).isolation).toBeUndefined();
    expect(buildNewSessionCreate({ ...base, cwd: '', workspaceId: 'wd_fixture_0123456789ab', worktree: false }).isolation).toBeUndefined();
    expect(buildNewSessionCreate({ ...base, cwd: '', workspaceId: 'wd_fixture_0123456789ab', worktree: true }))
      .toMatchObject({ workspace_id: 'wd_fixture_0123456789ab', isolation: { kind: 'worktree' } });
    expect(buildNewSessionCreate({ ...base, cwd: 'C:/repo', worktree: true }))
      .toMatchObject({ metadata: { cwd: 'C:/repo' }, isolation: { kind: 'worktree' } });
  });
});

describe('useNewSessionDraft agent profile scope', () => {
  it('clears touched native controls when choosing a bare engine and preserves it across remount', async () => {
    client.listModels.mockResolvedValue({ items: [model('provider/alpha', 'high')] });
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent', 'provider/alpha', 'high')] });
    await renderDraft();
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);
    await act(async () => {
      state.setModelOverride('provider/alpha');
      state.setEffortOverride('high');
      state.setExecution({ executor: 'claude-acp', profile: undefined, overrides: undefined });
    });
    state = await settleDraft((value) => value.execution.executor === 'claude-acp');
    expect(state.modelOverride).toBeUndefined();
    expect(state.effectiveEffort).toBeUndefined();
    expect(readStoredDraft()).toMatchObject({ execution: { executor: 'claude-acp' } });
    await unmountDraft();
    client.listModels.mockReturnValue(new Promise(() => {}));
    client.listNamedAgentProfiles.mockReturnValue(new Promise(() => {}));
    await renderDraft();
    state = await settleDraft((value) => value.execution.executor === 'claude-acp' && value.agentProfileCatalogPending);
    await act(async () => { await state.send('Bare engine', []); });
    expect(client.createSession.mock.calls[0]![0].agent_config).toEqual({
      execution: { executor: 'claude-acp' }, plan_mode: false,
    });
    expect(navigate).toHaveBeenCalled();
  });

  it('keeps remote cwd/draft separate from local and rejects Windows paths without sending', async () => {
    localStorage.setItem('kiki.newSessionDraft', JSON.stringify({ cwd: 'C:/local/project' }));
    scope.id = 'ssh:host-1';
    scope.label = 'Example';
    client.listNamedAgentProfiles.mockResolvedValue({ items: [
      { name: 'agent', source: 'builtin', main: true, disabled: false, routes: [] },
    ] });
    await renderDraft();
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);
    expect(state.cwd).toBe('');
    expect(state.canBrowseForWorkspace).toBe(false);
    await act(async () => { state.setCwd('C:/local/project'); });
    state = await settleDraft((value) => value.cwd === 'C:/local/project' && !value.agentProfileCatalogPending);
    await act(async () => { void state.send('Remote', []); });
    expect(client.createSession).not.toHaveBeenCalled();
    state = await settleDraft((value) => value.error !== null);
    expect(state.error).toBeTruthy();
    await act(async () => { state.setCwd('/home/dev/project'); });
    state = await settleDraft((value) => value.cwd === '/home/dev/project');
    expect(JSON.parse(localStorage.getItem('kiki.draft.new.ssh:host-1') ?? '{}')).toMatchObject({ cwd: '/home/dev/project' });
    expect(JSON.parse(localStorage.getItem('kiki.newSessionDraft') ?? '{}')).toMatchObject({ cwd: 'C:/local/project' });
  });
  const workspace = (id: string, name: string) => ({
    id,
    name,
    root: `/workspace/${name.toLowerCase()}`,
    pinned: false,
    isGit: false,
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

  it('refreshes workspace choices after creation but leaves them unchanged on a failed submit', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent')] });
    const queryClient = await renderDraft();
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);
    const before = client.listWorkspaces.mock.calls.length;
    client.createSession.mockRejectedValueOnce(new Error('directory unavailable'));
    await act(async () => { await state.send('Start work', []); });
    expect(client.listWorkspaces).toHaveBeenCalledTimes(before);
    state = await settleDraft((value) => value.error === 'directory unavailable' && !value.busy);
    client.listWorkspaces.mockResolvedValue({ items: [workspace('wd_new', 'New')] });
    await act(async () => { await state.send('Start work', []); });
    state = await settleDraft((value) => value.workspaces.some((item) => item.id === 'wd_new'));
    expect(queryClient.getQueryData<{ items: { id: string }[] }>(['workspaces'])?.items[0]?.id).toBe('wd_new');
    expect(client.createSession).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('hands the confirmed creation to the exact connection scope, not the local draft scope', async () => {
    scope.id = 'space:example';
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent')] });
    const queryClient = await renderDraft();
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);
    client.createSession.mockRejectedValueOnce(new Error('creation failed'));
    await act(async () => { await state.send('Start work', []); });
    expect(queryClient.getQueryData(['space-view-target', scope.id, 'session', 'session-new'])).toBeUndefined();
    expect(navigate).not.toHaveBeenCalled();
    state = await settleDraft((value) => value.error === 'creation failed' && !value.busy);
    await act(async () => { await state.send('Start work', []); });
    expect(queryClient.getQueryData(['space-view-target', scope.id, 'session', 'session-new'])).toBe(true);
    expect(queryClient.getQueryData(['space-view-target', 'local', 'session', 'session-new'])).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith('/s/session-new', expect.objectContaining({
      state: expect.objectContaining({ createdSession: { id: 'session-new', scopeId: scope.id }, initialPrompt: 'Start work' }),
    }));
  });

  it('uses workspace Git metadata and refreshes it with the workspace list', async () => {
    client.listWorkspaces.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha')] });
    const queryClient = await renderDraft();
    let state = await settleDraft((value) => !value.workspacesLoading);
    expect(state.worktreeAvailability).toEqual({ kind: 'not-git' });
    expect(client.klient.rest.workspaces.inspect).not.toHaveBeenCalled();
    client.listWorkspaces.mockResolvedValue({ items: [{ ...workspace('wd_alpha', 'Alpha'), isGit: true }] });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ['workspaces'] }); });
    state = await settleDraft((value) => value.worktreeAvailability.kind === 'ready');
    expect(state.worktreeAvailability).toEqual({ kind: 'ready', root: '/workspace/alpha' });
    expect(client.klient.rest.workspaces.inspect).not.toHaveBeenCalled();
    await act(async () => { state.setCwd('/workspace/alpha/'); });
    state = await settleDraft((value) => value.cwd === '/workspace/alpha/');
    expect(state.worktreeAvailability.kind).toBe('ready');
    expect(client.klient.rest.workspaces.inspect).not.toHaveBeenCalled();
  });

  it('inspects unregistered cwd on the backend and hides an unavailable result', async () => {
    const inspection = deferred<{ isGit: boolean }>();
    client.klient.rest.workspaces.inspect.mockReturnValue(inspection.promise);
    const queryClient = await renderDraft();
    let state = await settleDraft((value) => !value.workspacesLoading);
    expect(state.worktreeAvailability.kind).toBe('hidden');
    await act(async () => { state.setCwd('C:/example/project'); });
    state = await settleDraft(() => client.klient.rest.workspaces.inspect.mock.calls.length > 0);
    expect(state.worktreeAvailability.kind).toBe('hidden');
    expect(client.klient.rest.workspaces.inspect).toHaveBeenCalledExactlyOnceWith('C:/example/project');
    inspection.resolve({ isGit: true });
    state = await settleDraft((value) => value.worktreeAvailability.kind === 'ready');
    expect(state.worktreeAvailability).toEqual({ kind: 'ready', root: 'C:/example/project' });
    client.klient.rest.workspaces.inspect.mockResolvedValue({ isGit: false });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ['workspaces'] }); });
    state = await settleDraft((value) => value.worktreeAvailability.kind === 'not-git');
    expect(client.klient.rest.workspaces.inspect).toHaveBeenCalledTimes(2);
    client.klient.rest.workspaces.inspect.mockRejectedValue(new Error('unavailable'));
    await act(async () => { state.setCwd('C:/example/other'); });
    await settleDraft(() => client.klient.rest.workspaces.inspect.mock.calls.length === 3);
    expect(latestDraftState?.worktreeAvailability.kind).toBe('hidden');
    expect(latestDraftState?.workspaces).toEqual([]);
  });

  it('does not inspect remote cwd', async () => {
    scope.id = 'ssh:example';
    scope.label = 'example';
    await renderDraft();
    let state = await settleDraft((value) => !value.workspacesLoading);
    await act(async () => { state.setCwd('/home/example/project'); });
    state = await settleDraft((value) => value.cwd === '/home/example/project');
    expect(state.worktreeAvailability.kind).toBe('remote');
    expect(client.klient.rest.workspaces.inspect).not.toHaveBeenCalled();
  });

  it('uses unscoped profiles and creates without a target on first run', async () => {
    const catalog = deferred<{ items: NamedAgentProfile[] }>();
    client.listNamedAgentProfiles.mockReturnValue(catalog.promise);

    await renderDraft();
    let state = await settleDraft((value) =>
      value.agentProfileCatalogPending && client.listNamedAgentProfiles.mock.calls.length === 1
    );
    expect(state.autoWorkspace).toBe(true);
    expect(state.agentProfileCatalogMode).toEqual({ mode: 'unscoped' });
    client.createSession.mockRejectedValueOnce(new Error('Binding rejected by server'));
    await act(async () => { await state.send('Send without waiting for the profile catalog', []); });
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({ agent_config: expect.objectContaining({ profile: 'agent' }) }));
    client.createSession.mockClear();

    catalog.resolve({ items: [profile('agent'), { ...profile('auto-lead'), source: 'user' }] });
    state = await settleDraft((value) => !value.agentProfileCatalogPending);
    expect(client.listNamedAgentProfiles).toHaveBeenCalledWith({ unscoped: true });
    await act(async () => { state.setAgentProfile('auto-lead'); });
    state = await settleDraft((value) => value.agentProfile === 'auto-lead');
    const body = await sentBody(state);
    expect(body.workspace_id).toBeUndefined();
    expect(body.metadata).toBeUndefined();
    expect(body.agent_config?.profile).toBe('auto-lead');
  });

  it('sends the preserved initial agent before catalog completion and enriches its workspace pins later', async () => {
    const catalog = deferred<{ items: NamedAgentProfile[] }>();
    client.listWorkspaces.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha')] });
    client.listModels.mockResolvedValue({ items: [model('provider/alpha', 'high')] });
    client.listNamedAgentProfiles.mockReturnValue(catalog.promise);

    await renderDraft({ initialWorkspaceId: 'wd_alpha', initialProfile: 'workspace-main' });
    let state = await settleDraft((value) =>
      value.agentProfileCatalogPending && client.listNamedAgentProfiles.mock.calls.length === 1
    );
    client.createSession.mockRejectedValueOnce(new Error('Binding rejected by server'));
    await act(async () => { await state.send('Send the saved choice', []); });
    const early = client.createSession.mock.calls[0]![0] as SessionCreate;
    expect(early.workspace_id).toBe('wd_alpha');
    expect(early.agent_config?.profile).toBe('workspace-main');
    expect(early.agent_config?.model).toBeUndefined();
    expect(early.agent_config?.thinking).toBeUndefined();
    client.createSession.mockClear();

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

  it('keeps the initial selection sendable through a catalog error and background retry', async () => {
    const catalog = deferred<{ items: NamedAgentProfile[] }>();
    client.listWorkspaces.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha')] });
    client.listModels.mockResolvedValue({ items: [model('provider/alpha', 'high')] });
    client.listNamedAgentProfiles.mockReturnValue(catalog.promise);

    const queryClient = await renderDraft({ initialWorkspaceId: 'wd_alpha', initialProfile: 'workspace-main' });
    let state = await settleDraft((value) =>
      value.agentProfileCatalogPending && client.listNamedAgentProfiles.mock.calls.length === 1
    );
    client.createSession.mockRejectedValueOnce(new Error('server binding unavailable'));
    await act(async () => {
      await state.send('Still validating', []);
      catalog.reject(new Error('catalog unavailable'));
    });
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: 'wd_alpha', agent_config: expect.objectContaining({ profile: 'workspace-main' }),
    }));
    client.createSession.mockClear();
    state = await settleDraft((value) => !value.agentProfileCatalogPending);
    expect(state.agentProfile).toBe('workspace-main');
    expect(state.modelOverride).toBeUndefined();
    expect(readStoredDraft()).toMatchObject({
      profile: 'workspace-main', modelFromProfile: true, effortFromProfile: true,
    });
    client.createSession.mockRejectedValueOnce(new Error('server binding unavailable'));
    await act(async () => {
      await state.send('An error is not permission to fall back', []);
    });
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: 'wd_alpha', agent_config: expect.objectContaining({ profile: 'workspace-main' }),
    }));
    client.createSession.mockClear();

    const retry = deferred<{ items: NamedAgentProfile[] }>();
    client.listNamedAgentProfiles.mockReturnValue(retry.promise);
    await act(async () => {
      void queryClient.refetchQueries({ queryKey: ['agentProfiles'] });
    });
    state = await settleDraft((value) =>
      value.agentProfileCatalogPending && client.listNamedAgentProfiles.mock.calls.length === 2
    );
    client.createSession.mockRejectedValueOnce(new Error('server binding unavailable'));
    await act(async () => {
      await state.send('Retry is still pending', []);
    });
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: 'wd_alpha', agent_config: expect.objectContaining({ profile: 'workspace-main' }),
    }));
    client.createSession.mockClear();
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
    client.createSession.mockRejectedValueOnce(new Error('server binding unavailable'));
    await act(async () => {
      await state.send('Keep the selected profile without stale workspace pins', []);
    });
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: 'wd_beta', agent_config: expect.objectContaining({ profile: 'alpha-only' }),
    }));
    expect(client.createSession.mock.calls[0]![0].agent_config?.model).toBeUndefined();
    expect(client.createSession.mock.calls[0]![0].agent_config?.thinking).toBeUndefined();
    client.createSession.mockClear();

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

  it('restores the profile selection immediately and enriches its pins after the remounted catalog resolves', async () => {
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
      execution: { executor: 'native', profile: 'workspace-choice' },
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
    client.createSession.mockRejectedValueOnce(new Error('server binding unavailable'));
    await act(async () => {
      await state.send('Restore the selection while its derived pins are unresolved', []);
    });
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: 'wd_alpha', agent_config: expect.objectContaining({ profile: 'workspace-choice' }),
    }));
    expect(client.createSession.mock.calls[0]![0].agent_config?.model).toBeUndefined();
    expect(client.createSession.mock.calls[0]![0].agent_config?.thinking).toBeUndefined();
    client.createSession.mockClear();

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
    client.createSession.mockRejectedValueOnce(new Error('server binding unavailable'));
    await act(async () => {
      await state.send('Send the exact directory while its catalog is pending', []);
    });
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { cwd: '/workspace/custom' }, agent_config: expect.objectContaining({ profile: 'alpha-only' }),
    }));
    expect(client.createSession.mock.calls[0]![0].workspace_id).toBeUndefined();
    expect(client.createSession.mock.calls[0]![0].agent_config?.model).toBeUndefined();
    client.createSession.mockClear();
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
    expect(client.listNamedAgentProfiles.mock.calls.at(-1)).toEqual([{ unscoped: true }]);
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
    // The default profile reads as the product name, not the literal id.
    expect(options[0]?.label).toBe('composer.agentDefaultOption');
    expect(options[1]?.label).toBe('grok-only');
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
          allowed_subagents: [
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


describe('new-session projected model permission', () => {
  const profile: NamedAgentProfile = { name: 'agent', source: 'user', main: true, disabled: false, routes: [],
    pinned_model_alias: 'fixture/outside', restrict_models_to_menu: true, effective_model_aliases: ['fixture/inside'] };
  beforeEach(() => {
    client.listModels.mockResolvedValue({ items: [
      { id: 'fixture/inside', provider_id: 'fixture', remote_id: 'inside' },
      { id: 'fixture/outside', provider_id: 'fixture', remote_id: 'outside' },
    ] });
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile] });
  });
  it('creates a main session with the user-selected model outside its hard menu without a fallback', async () => {
    await renderDraft();
    let state = await settleDraft((value) => !value.agentProfileCatalogPending && value.modelOverride === 'fixture/outside');
    await act(async () => state.setModelOverride('outside'));
    state = await settleDraft((value) => value.modelOverride === 'outside');
    await act(async () => { await state.send('hello', []); });
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({ agent_config: expect.objectContaining({ model: 'outside' }) }));
  });
  it.each([[], undefined])('permits main creation with an empty or missing effective set (%s)', async (effective_model_aliases) => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [{ ...profile, pinned_model_alias: 'fixture/inside', effective_model_aliases }] });
    await renderDraft();
    const state = await settleDraft((value) => !value.agentProfileCatalogPending && value.modelOverride === 'fixture/inside');
    await act(async () => { await state.send('hello', []); });
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({ agent_config: expect.objectContaining({ model: 'fixture/inside' }) }));
  });
});


describe('new-session SSH creation handoff', () => {
  beforeEach(() => {
    client.listModels.mockResolvedValue({ items: [{ id: 'fixture/model', provider_id: 'fixture', remote_id: 'model' }] });
    client.listNamedAgentProfiles.mockResolvedValue({ items: [{ name: 'agent', source: 'builtin', main: true, disabled: false, routes: [], pinned_model_alias: 'fixture/model' }] });
    client.klient.rest.ssh.addSessionHost.mockReset().mockResolvedValue({});
  });
  const hosts = [{ kind: 'ssh' as const, id: 'example-host', name: 'Example host' }];
  it.each(['prompt', 'skill'])('joins selected hosts after creation and before navigating the first %s, and keeps them out of it', async (kind) => {
    const join = deferred<object>();
    client.klient.rest.ssh.addSessionHost.mockReturnValue(join.promise);
    await renderDraft();
    const state = await settleDraft((value) => !value.agentProfileCatalogPending && value.modelOverride === 'fixture/model');
    let sending: void | Promise<unknown>;
    await act(async () => { sending = kind === 'prompt' ? state.send('Inspect', hosts) : state.activateSkill('inspect', '--new\nKeep this line.', hosts, '/inspect --new\nKeep this line.'); });
    expect(client.klient.rest.ssh.addSessionHost).toHaveBeenCalledWith('session-new', 'example-host');
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => { join.resolve({}); await sending; });
    // The join is a session fact; the message itself carries no host.
    const carried = navigate.mock.calls[0]![1]!.state as Record<string, unknown>;
    expect(JSON.stringify(carried)).not.toContain('example-host');
    expect(navigate).toHaveBeenCalledWith('/s/session-new', expect.objectContaining({ state: expect.objectContaining(kind === 'prompt'
      ? { initialAttachments: [], initialPrompt: 'Inspect' } : { initialSkill: { name: 'inspect', args: '--new\nKeep this line.', attachments: [], userInput: '/inspect --new\nKeep this line.' } }) }));
  });
  it('keeps file mentions on the first message while the host joins the session', async () => {
    await renderDraft();
    const state = await settleDraft((value) => !value.agentProfileCatalogPending && value.modelOverride === 'fixture/model');
    const mention = { kind: 'file' as const, path: 'src/app.ts', name: 'app.ts', isDir: false };
    await act(async () => { await state.send('Inspect', [...hosts, mention]); });
    expect(client.klient.rest.ssh.addSessionHost).toHaveBeenCalledWith('session-new', 'example-host');
    const carried = navigate.mock.calls[0]![1]!.state as { initialAttachments: unknown };
    expect(carried.initialAttachments).toEqual([mention]);
  });
  it('does not hand off a prompt after join failure and reuses the created session on retry', async () => {
    client.klient.rest.ssh.addSessionHost.mockRejectedValueOnce(new Error('Join failed'));
    await renderDraft();
    let state = await settleDraft((value) => !value.agentProfileCatalogPending && value.modelOverride === 'fixture/model');
    await act(async () => { await state.send('Inspect', hosts); });
    expect(navigate).not.toHaveBeenCalled();
    state = await settleDraft((value) => !value.busy && value.error === 'Join failed');
    await act(async () => { await state.send('Inspect', hosts); });
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});


describe('persona model and effort choice sources', () => {
  beforeEach(() => {
    client.listModels.mockResolvedValue({ items: [{
      id: 'fixture/model', provider_id: 'fixture', remote_id: 'model',
      support_efforts: ['high'], default_effort: 'high',
    }] });
    client.listNamedAgentProfiles.mockResolvedValue({ items: [{
      name: 'agent', source: 'builtin', main: true, disabled: false, routes: [],
      pinned_model_alias: 'fixture/model', thinking_effort: 'high',
    }] });
    client.getPersona.mockResolvedValue({ revision: 'revision-1', definition: {
      id: 'sample', name: 'Sample', description: 'Sample persona',
      modelAlias: 'fixture/model', thinkingEffort: 'high',
    } });
  });

  it.each([false, true])('shows persona defaults but submits only explicit same-value choices (explicit=%s)', async (explicit) => {
    await renderDraft({ initialPersona: 'sample' });
    let state = await settleDraft((value) => value.persona !== undefined && !value.personaPending && !value.agentProfileCatalogPending);
    expect(state.modelOverride).toBe('fixture/model');
    expect(state.effectiveEffort).toBe('high');
    expect(readStoredDraft()['modelOverride']).toBeUndefined();
    expect(readStoredDraft()['effortOverride']).toBeUndefined();
    if (explicit) {
      await act(async () => { state.setModelOverride('fixture/model'); state.setEffortOverride('high'); });
      state = latestDraftState!;
      expect(readStoredDraft()).toMatchObject({ modelOverride: 'fixture/model', effortOverride: 'high', modelFromProfile: false, effortFromProfile: false });
    }
    await act(async () => { await state.send('Hello', []); });
    const body = client.createSession.mock.calls[0]![0] as SessionCreate;
    expect(body.persona).toBe('sample');
    expect(body.agent_config?.model).toBe(explicit ? 'fixture/model' : undefined);
    expect(body.agent_config?.thinking).toBe(explicit ? 'high' : undefined);
    const handoff = navigate.mock.calls[0]![1].state;
    expect(handoff.model).toBe(explicit ? 'fixture/model' : undefined);
    expect(handoff.thinking).toBe(explicit ? 'high' : undefined);
  });

  it('carries a bare external engine to the first message with the same emptiness', async () => {
    // The create body and the first prompt are two hops, and the second one
    // used to re-send the displayed model, effort and approval mode — putting
    // back exactly the overrides the create had just declined to send.
    await renderDraft({});
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);
    await act(async () => {
      state.setExecution({ executor: 'claude-acp', profile: undefined, overrides: undefined });
    });
    state = latestDraftState!;
    // The page still shows Kiki's own default; none of it was chosen here, and
    // whatever it is, it must not reach the harness.
    expect(state.permissionMode).toBe('auto');
    await act(async () => { await state.send('Hello', []); });

    const body = client.createSession.mock.calls[0]![0] as SessionCreate;
    expect(body.agent_config).toEqual({ execution: { executor: 'claude-acp' }, plan_mode: expect.any(Boolean) });
    const handoff = navigate.mock.calls[0]![1].state as Record<string, unknown>;
    expect(handoff['model']).toBeUndefined();
    expect(handoff['thinking']).toBeUndefined();
    expect(handoff['permissionMode']).toBeUndefined();
  });

  it('sends an approval mode the user picked on a bare external engine', async () => {
    await renderDraft({});
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);
    await act(async () => {
      state.setExecution({ executor: 'claude-acp', profile: undefined, overrides: undefined });
    });
    state = latestDraftState!;
    await act(async () => { state.setPermissionMode('yolo'); });
    state = latestDraftState!;
    await act(async () => { await state.send('Hello', []); });

    const body = client.createSession.mock.calls[0]![0] as SessionCreate;
    expect(body.agent_config).toMatchObject({ execution: { executor: 'claude-acp' }, permission_mode: 'yolo' });
    const handoff = navigate.mock.calls[0]![1].state as Record<string, unknown>;
    expect(handoff['permissionMode']).toBe('yolo');
  });

  it('keeps unpinned persona profile defaults inherited and clearing persona restores ordinary profile submission', async () => {
    client.getPersona.mockResolvedValue({ revision: 'revision-1', definition: { id: 'sample', name: 'Sample', description: 'Sample persona' } });
    await renderDraft({ initialPersona: 'sample' });
    let state = await settleDraft((value) => value.persona !== undefined && !value.personaPending && !value.agentProfileCatalogPending);
    expect(state.modelOverride).toBe('fixture/model');
    await act(async () => { state.selectPersona(undefined); });
    state = latestDraftState!;
    await act(async () => { await state.send('Hello', []); });
    const body = client.createSession.mock.calls[0]![0] as SessionCreate;
    expect(body.persona).toBeUndefined();
    expect(body.agent_config).toMatchObject({ profile: 'agent', model: 'fixture/model', thinking: 'high' });
  });
});

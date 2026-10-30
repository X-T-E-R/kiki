// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, MemoryRouter, RouterProvider, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionCreateSchema, ErrorCode, type SessionCreate } from '@kiki/protocol';

import { I18nProvider } from '../i18n';
import { ApiError, type NamedAgentProfile } from '../lib/client';
import { Composer, buildAgentProfileOptions, resolveSelectedEffort } from './Composer';
import {
  AUTO_WORKSPACE_ID,
  buildNewSessionCreate,
  isAbsoluteCwdPath,
  isAbsoluteRemoteCwdPath,
  useNewSessionDraft,
  type NewSessionDraftState,
} from './NewSessionDraft';
import { clearPendingNewSessionCapabilities, pendingNewSessionCapabilities, setPendingOptionalChoice, setPendingPluginChoice, type PendingCapabilityScope } from './capabilities/newSessionCapabilities';
import { readDraft, readComposerState, resetDraftMemoryForTests, resetComposerMemoryForTests, writeDraft, flushDrafts } from '@kiki/session-core/composer';
import { configureSpaceStorage } from '../lib/spaceStorage';
import { personaDailyDraftKey, personaDailySettingsKey } from './persona/personaNavigation';

const { client, navigate, scope } = vi.hoisted(() => ({
  scope: { id: 'local', spaceKey: 'local-space', connectionId: null as string | null, label: null as string | null },
  client: {
    listWorkspaces: vi.fn(),
    listWorkspaceCatalog: vi.fn(),
    klient: { rest: { agents: { previewFile: vi.fn() }, workspaces: { inspect: vi.fn() }, ssh: { addSessionHost: vi.fn() } } },
    getConfig: vi.fn(),
    listModels: vi.fn(),
    listExecutors: vi.fn(async () => ({ items: [{ id: 'native', label: 'Kiki', protocol: 'native', status: 'ready', model_binding: 'mapped', thinking_binding: 'mapped' }] })),
    listDraftSkills: vi.fn(async () => ({ skills: [] })),
    listPersonas: vi.fn(async () => []),
    meta: vi.fn(async () => ({ experimental_flags: { native_ssh: false } })),
    listNamedAgentProfiles: vi.fn(),
    getAuth: vi.fn(),
    createSession: vi.fn(),
    getSessionCreation: vi.fn(),
    getPersona: vi.fn(),
    setPluginUsage: vi.fn(),
    setSessionOptionalCapability: vi.fn(),
    previewAgentProfileFile: vi.fn((...args: unknown[]) => client.klient.rest.agents.previewFile(...args)),
  },
  navigate: vi.fn(),
}));

vi.mock('../state/connection', () => ({
  useConnection: () => ({ client, scopeId: scope.id, spaceKey: scope.spaceKey, connectionId: scope.connectionId, sshLabel: scope.label }),
  useOptionalConnection: () => undefined,
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
  scope.spaceKey = 'local-space';
  scope.connectionId = null;
  scope.label = null;
  latestDraftState = undefined;
  configureSpaceStorage(null);
  resetDraftMemoryForTests();
  resetComposerMemoryForTests();
  localStorage.clear();
  navigate.mockReset();
  client.listWorkspaceCatalog.mockReset().mockResolvedValue({ items: [] });
  client.klient.rest.workspaces.inspect.mockReset().mockResolvedValue({ isGit: false });
  client.klient.rest.agents.previewFile.mockReset();
  client.getConfig.mockReset().mockResolvedValue({});
  client.listModels.mockReset().mockResolvedValue({ items: [] });
  client.listNamedAgentProfiles.mockReset().mockResolvedValue({ items: [] });
  client.getAuth.mockReset().mockResolvedValue({ ready: true });
  client.createSession.mockReset().mockResolvedValue({ id: 'session-new' });
  client.getSessionCreation.mockReset().mockImplementation(async (creationId: string) => ({
    creation_id: creationId,
    session_id: `session_${creationId}`,
    status: 'pending',
  }));
  client.getPersona.mockReset();
  client.setPluginUsage.mockReset().mockResolvedValue({});
  client.setSessionOptionalCapability.mockReset().mockResolvedValue({});
  clearPendingNewSessionCapabilities();
});

afterEach(async () => {
  await unmountDraft();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

function DraftHarness(props: { initialWorkspaceId?: string; initialProfile?: string; initialPersona?: string; isDailyDraft?: boolean; prefillNavigationKey?: string; composer?: boolean }) {
  const state = useNewSessionDraft(props);
  latestDraftState = state;
  if (!props.composer) return null;
  return createElement(MemoryRouter, null, createElement(Composer, {
    busy: state.busy, disabled: state.busy, value: state.draft, onChange: state.updateDraft,
    model: state.modelOverride, defaultModel: undefined, serverDefaultModel: state.inheritedDefault,
    modelSource: state.modelSource, agentProfile: state.agentProfile, onChangeAgentProfile: state.setAgentProfile,
    execution: state.execution, onChangeExecution: state.setExecution,
    personaPick: { value: state.persona?.definition, onChange: state.selectPersona },
    permissionMode: state.permissionMode, planMode: state.planMode, goalObjective: state.goalObjective,
    efforts: state.supportedEfforts, effort: state.effectiveEffort, agentProfileCatalogMode: state.agentProfileCatalogMode,
    attachments: state.attachments, onChangeAttachments: state.setAttachments, onChangeModel: state.setModelOverride,
    onChangePermissionMode: state.setPermissionMode, onChangePlanMode: state.setPlanMode,
    onChangeGoalObjective: state.setGoalObjective, onChangeEffort: state.setEffortOverride, onSend: state.send,
  }));
}

async function renderDraft(
  props: { initialWorkspaceId?: string; initialProfile?: string; initialPersona?: string; isDailyDraft?: boolean; prefillNavigationKey?: string; composer?: boolean } = {},
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
  it.each([undefined, 'profiles/example.md'])('keeps inbound workspace and permission on the session (%s)', (profileFile) => {
    const body = buildNewSessionCreate({
      cwd: 'C:/example/project', profile: 'agent', permissionMode: 'review', planMode: false,
      model: 'example/model', thinking: 'high',
      execution: { executor: 'external-client', profile: undefined, overrides: undefined,
        external_connection_id: 'conn_example', external_connection_name: 'Untrusted display name', profile_file: profileFile },
    });
    expect(body.metadata).toEqual({ cwd: 'C:/example/project', externalClient: { driver: 'external', connectionId: 'conn_example' } });
    expect(body.agent_config).toEqual({ permission_mode: 'review', plan_mode: false,
      ...(profileFile === undefined ? {} : { execution: { executor: 'native', profile_file: profileFile } }) });
    const registered = buildNewSessionCreate({
      cwd: '', workspaceId: 'wd_example_0123456789ab', profile: 'agent', permissionMode: 'manual', planMode: false,
      execution: { executor: 'external-client', profile: undefined, overrides: undefined, external_connection_id: 'conn_example' },
    });
    expect(registered.workspace_id).toBe('wd_example_0123456789ab');
    expect(registered.metadata).not.toHaveProperty('cwd');
    expect(sessionCreateSchema.safeParse(registered).success).toBe(true);
    const automatic = buildNewSessionCreate({
      cwd: '', profile: 'agent', permissionMode: 'manual', planMode: false,
      execution: { executor: 'external-client', profile: undefined, overrides: undefined, external_connection_id: 'conn_example' },
    });
    expect(automatic.metadata).toEqual({ externalClient: { driver: 'external', connectionId: 'conn_example' } });
    expect(sessionCreateSchema.safeParse(automatic).success).toBe(true);
  });

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
      execution: { executor: 'claude-acp', profile: undefined, profile_file: undefined, overrides: undefined },
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
      execution: { executor: 'claude-acp', profile: undefined, profile_file: undefined, overrides: undefined },
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
      execution: { executor: 'claude-acp', profile: undefined, profile_file: undefined, overrides: undefined },
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

  it('sends an explicit native model and effort even when the picker parked them on unpublished overrides', () => {
    const body = buildNewSessionCreate({
      cwd: 'C:/repo',
      profile: 'agent',
      execution: {
        executor: 'native',
        profile: 'agent',
        profile_file: undefined,
        overrides: { model: 'axon/gpt-6.1-sol', thinking: 'xhigh' },
      },
      model: 'axon/gpt-6.1-sol',
      thinking: 'xhigh',
      permissionMode: 'manual',
      planMode: false,
      modelTouched: true,
      effortTouched: true,
      permissionTouched: false,
    });
    expect(body.agent_config).toEqual({
      profile: 'agent',
      model: 'axon/gpt-6.1-sol',
      thinking: 'xhigh',
      permission_mode: 'manual',
      plan_mode: false,
    });
    expect(body.agent_config).not.toHaveProperty('execution');
  });

  it('leaves the native engine and an external profile exactly as before', () => {
    // Native keeps every legacy field, untouched or not: that path has always
    // sent them and the server resolves them against Kiki's own defaults.
    const native = buildNewSessionCreate({
      cwd: 'C:/repo',
      profile: 'agent',
      execution: { executor: 'native', profile: 'agent', profile_file: undefined, overrides: undefined },
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
      execution: { executor: 'claude-acp', profile: 'claude-reviewer', profile_file: undefined, overrides: undefined },
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
        profile: undefined, profile_file: undefined,
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
        profile: undefined, profile_file: undefined,
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
      execution: { executor: 'claude-acp', profile: undefined, profile_file: undefined, overrides: undefined },
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
        profile: undefined, profile_file: undefined,
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

  it('creates a session that runs a profile file, without naming a registered profile', () => {
    const body = buildNewSessionCreate({
      cwd: '/work',
      profile: 'agent',
      execution: {
        executor: 'native',
        profile: undefined,
        profile_file: '/work/profiles/research.md',
        overrides: undefined,
      },
      // A file pick carries no model or effort: nothing was chosen, and the
      // file's own configuration supplies whatever it declares.
      model: undefined,
      thinking: undefined,
      permissionMode: 'manual',
      planMode: false,
      modelTouched: false,
      effortTouched: false,
      permissionTouched: false,
    });
    expect(body.agent_config).toEqual({
      execution: { executor: 'native', profile_file: '/work/profiles/research.md' },
      permission_mode: 'manual',
      plan_mode: false,
    });
    expect(body.agent_config).not.toHaveProperty('profile');
  });

  it('leaves an external engine’s profile file its own model and effort', () => {
    // The process never resolved the file, so it cannot know which model or
    // effort it declares: the value merely on display must not become an
    // override that outranks the file.
    const body = buildNewSessionCreate({
      cwd: '/work',
      profile: 'agent',
      execution: {
        executor: 'claude-acp',
        profile: undefined,
        profile_file: '/work/profiles/research.md',
        overrides: undefined,
      },
      model: 'vendor/model-a',
      thinking: 'high',
      permissionMode: 'auto',
      planMode: false,
      modelTouched: false,
      effortTouched: false,
      permissionTouched: false,
    });
    expect(body.agent_config).toEqual({
      execution: { executor: 'claude-acp', profile_file: '/work/profiles/research.md' },
      plan_mode: false,
    });
  });

  it('still lets a touched control win over an engine that names no override', () => {
    const body = buildNewSessionCreate({
      cwd: 'C:/repo',
      profile: 'agent',
      execution: { executor: 'claude-acp', profile: undefined, profile_file: undefined, overrides: undefined },
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
    // The persona's own delivery decides: the composer never pins one, so a
    // persona saved as "reply" is not turned into a message session here.
    expect(body).not.toHaveProperty('delivery');
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
      state.setExecution({ executor: 'claude-acp', profile: undefined, profile_file: undefined, overrides: undefined });
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

  it('can send from catalog metadata while only the chosen root is being inspected', async () => {
    client.listWorkspaces.mockReset().mockImplementation(() => new Promise(() => {}));
    const entry = { id: 'wd_selected', name: 'Selected', root: '/workspace/selected', pinned: false, created_at: '2026-09-05T00:00:00.000Z', last_opened_at: '2026-09-05T00:00:00.000Z' };
    const other = { ...entry, id: 'wd_other', name: 'Other', root: '/workspace/other' };
    client.listWorkspaceCatalog.mockResolvedValue({ items: [entry, other] });
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent')] });
    const inspection = deferred<{ isGit: boolean }>();
    client.klient.rest.workspaces.inspect.mockReturnValue(inspection.promise);
    const queryClient = await renderDraft({ initialWorkspaceId: 'wd_selected' });
    const state = await settleDraft((value) => value.selectionReady);
    expect(state.targetReady).toBe(true);
    expect(state.effectiveWorkspace?.id).toBe('wd_selected');
    expect(state.worktreeAvailability.kind).toBe('hidden');
    expect(client.listWorkspaces).not.toHaveBeenCalled();
    expect(client.klient.rest.workspaces.inspect).toHaveBeenCalledExactlyOnceWith('/workspace/selected');
    expect(queryClient.getQueryData(['workspaces'])).toBeUndefined();
    expect(queryClient.getQueryData(['workspaces', 'catalog'])).toEqual({ items: [entry, other] });
    await act(async () => { await state.send('Use the selected workspace', []); });
    expect(client.createSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspace_id: 'wd_selected' }));
  });

  it.each([40001, 50001])('does not infer automatic creation from workspace error %s and retries without losing the draft', async (code) => {
    client.listWorkspaceCatalog.mockRejectedValue(new ApiError({ code, msg: 'Workspace read failed', data: null }));
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent')] });
    await renderDraft();
    let state = await settleDraft((value) => value.workspacesError !== null);
    await act(async () => { state.updateDraft('Keep this prompt'); state.setAttachments([{ kind: 'file', path: '/workspace/input.txt', name: 'input.txt', isDir: false }]); });
    state = latestDraftState!;
    expect(state.autoWorkspace).toBe(false);
    expect(state.targetReady).toBe(false);
    expect(state.selectionReady).toBe(false);
    expect(state.workspacesError).toContain('Workspace read failed');
    expect(state.workspacesError).toContain(`code ${code}`);
    await act(async () => { await state.send(state.draft, state.attachments); });
    expect(client.createSession).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    client.listWorkspaceCatalog.mockResolvedValue({ items: [workspace('wd_selected', 'Selected')] });
    await act(async () => { state.retryWorkspaces(); });
    state = await settleDraft((value) => value.selectionReady);
    expect(state.workspacesError).toBeNull();
    expect(state.effectiveWorkspace?.id).toBe('wd_selected');
    expect(state.draft).toBe('Keep this prompt');
    expect(state.attachments).toHaveLength(1);
    await act(async () => { await state.send(state.draft, state.attachments); });
    expect(client.createSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspace_id: 'wd_selected' }));
  });

  it('keeps a selected workspace blocked during its pending or failed read instead of falling back to automatic creation', async () => {
    const listing = deferred<{ items: ReturnType<typeof workspace>[] }>();
    client.listWorkspaceCatalog.mockReturnValue(listing.promise);
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent')] });
    await renderDraft({ initialWorkspaceId: 'wd_selected' });
    let state = latestDraftState!;
    expect(state.selectionReady).toBe(false);
    expect(state.autoWorkspace).toBe(false);
    await act(async () => { await state.send('No guessed target', []); });
    expect(client.createSession).not.toHaveBeenCalled();
    await act(async () => { listing.reject(new Error('offline')); });
    state = await settleDraft((value) => value.workspacesError !== null);
    expect(state.workspaceId).toBe('wd_selected');
    expect(state.selectionReady).toBe(false);
    await act(async () => { state.selectWorkspace(AUTO_WORKSPACE_ID); });
    state = await settleDraft((value) => value.selectionReady);
    expect(state.autoWorkspace).toBe(true);
    await act(async () => { await state.send('Explicit automatic target', []); });
    expect(client.createSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspace_id: undefined }));
  });

  it('allows an explicit directory to recover from a failed workspace list without clearing its error or draft', async () => {
    client.listWorkspaceCatalog.mockRejectedValue(new Error('workspace list offline'));
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent')] });
    await renderDraft();
    let state = await settleDraft((value) => value.workspacesError !== null);
    await act(async () => { state.setCwd('/workspace/selected'); state.updateDraft('Use my folder'); });
    state = await settleDraft((value) => value.selectionReady);
    expect(state.workspacesError).toBe('workspace list offline');
    expect(state.autoWorkspace).toBe(false);
    await act(async () => { await state.send(state.draft, []); });
    expect(client.createSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ metadata: { cwd: '/workspace/selected' } }));
  });

  it.each([40001, 50001, -2])('shows create error %s without navigation or automatic resubmission and retains prompt, attachments and choices', async (code) => {
    client.listWorkspaceCatalog.mockResolvedValue({ items: [workspace('wd_selected', 'Selected')] });
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent')] });
    client.createSession.mockRejectedValue(new ApiError({ code, msg: 'Create failed', data: null }));
    await renderDraft({ initialWorkspaceId: 'wd_selected' });
    let state = await settleDraft((value) => value.selectionReady);
    await act(async () => { state.updateDraft('Preserve me'); state.setAttachments([{ kind: 'file', path: '/workspace/input.txt', name: 'input.txt', isDir: false }]); });
    state = latestDraftState!;
    await act(async () => { await state.send(state.draft, state.attachments); });
    state = latestDraftState!;
    if (code === -2) {
      // Code -2 reads as a slow-server timeout, not as the raw "Create failed".
      expect(state.error).toBe('The server is responding slowly. Try again shortly');
    } else {
      expect(state.error).toContain('Create failed');
      expect(state.error).toContain(`code ${code}`);
    }
    expect(state.creationNotice).toBe(code < 0 ? 'Creation is not confirmed yet. Check the result to continue with the same session. Starting another conversation keeps this attempt for later.' : null);
    expect(state.busy).toBe(false);
    expect(state.creationPending).toBe(false);
    expect(state.workspaceId).toBe('wd_selected');
    expect(state.draft).toBe('Preserve me');
    expect(state.attachments).toHaveLength(1);
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('releases pending state on cancellation, ignores late navigation, and opens the frozen accepted handoff explicitly', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent')] });
    const creation = deferred<{ id: string }>();
    client.createSession.mockReturnValue(creation.promise);
    await renderDraft();
    let state = await settleDraft((value) => value.selectionReady);
    await act(async () => { state.updateDraft('Preserve me'); });
    state = latestDraftState!;
    let submission: Promise<unknown> | undefined;
    await act(async () => { submission = state.send(state.draft, []); });
    const firstBody = client.createSession.mock.calls[0]![0] as SessionCreate;
    const firstPromptId = `new-session:${firstBody.creation_id}`;
    state = latestDraftState!;
    await act(async () => { state.cancelCreation(); state.setCwd('/workspace/other'); });
    state = latestDraftState!;
    expect(state.creationPending).toBe(false);
    expect(state.busy).toBe(false);
    expect(state.creationNotice).toContain('Stopped waiting');
    await act(async () => { await state.send('Must not re-create while waiting', []); });
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(client.getSessionCreation).toHaveBeenCalledWith(firstBody.creation_id);
    await act(async () => { creation.resolve({ id: 'session-accepted' }); await submission; });
    state = await settleDraft((value) => value.createdSessionId === 'session-accepted' && !value.creationPending);
    expect(state.creationNotice).toContain('The session was created');
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => { await state.openCreatedSession(); });
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/s/session-accepted', expect.objectContaining({
      state: expect.objectContaining({ initialPrompt: 'Preserve me', initialPromptId: firstPromptId }),
    }), expect.any(Function));
    expect(latestDraftState?.draft).toBe('Preserve me');
  });

  it.each(['prompt', 'skill'] as const)('cancels the first %s before handoff, keeps its draft and selections, and reuses the frozen first handoff on retry', async (kind) => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent')] });
    client.listModels.mockResolvedValue({ items: [model('fixture/manual', 'high')] });
    const creation = deferred<{ id: string }>();
    client.createSession.mockReturnValue(creation.promise);
    await renderDraft();
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);
    const text = kind === 'skill' ? '/review --fix' : 'Inspect this file';
    const attachments = [{ kind: 'file' as const, path: '/workspace/input.txt', name: 'input.txt', isDir: false }];
    await act(async () => {
      state.updateDraft(text);
      state.setAttachments(attachments);
      state.setModelOverride('fixture/manual');
      state.setEffortOverride('high');
    });
    state = latestDraftState!;
    let submission: Promise<unknown> | undefined;
    await act(async () => {
      submission = kind === 'skill' ? state.activateSkill('review', '--fix', attachments, text) : state.send(text, attachments);
      void state.send('Duplicate must not create', attachments);
    });
    expect(client.createSession).toHaveBeenCalledTimes(1);
    state = latestDraftState!;
    await act(async () => { state.cancelCreation(); state.updateDraft(`${text}\nMore context`); });
    expect(latestDraftState?.creationPending).toBe(false);
    expect(latestDraftState?.busy).toBe(false);
    await act(async () => { creation.resolve({ id: 'session-created-once' }); await submission; });
    expect(navigate).not.toHaveBeenCalled();
    state = latestDraftState!;
    expect(state.busy).toBe(false);
    expect(state.draft).toBe(`${text}\nMore context`);
    expect(state.attachments).toEqual(attachments);
    expect(state.modelOverride).toBe('fixture/manual');
    expect(state.effectiveEffort).toBe('high');
    await act(async () => { await state.send(state.draft, state.attachments); });
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/s/session-created-once', expect.objectContaining({
      state: expect.objectContaining(kind === 'prompt'
        ? { initialPrompt: text, initialAttachments: attachments, model: 'fixture/manual', thinking: 'high' }
        : { initialSkill: { name: 'review', args: '--fix', attachments, userInput: text }, model: 'fixture/manual', thinking: 'high' }),
    }), expect.any(Function));
  });

  it('restores explicit model and effort on a bare external draft into both first-send hops', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent')] });
    await renderDraft();
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);
    await act(async () => { state.setExecution({ executor: 'claude-acp', profile: undefined, profile_file: undefined, overrides: undefined }); });
    state = latestDraftState!;
    await act(async () => { state.setModelOverride('external/manual'); state.setEffortOverride('high'); });
    await unmountDraft();
    await renderDraft();
    state = await settleDraft((value) => !value.agentProfileCatalogPending);
    await act(async () => { await state.send('Use my choices', []); });
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      agent_config: expect.objectContaining({ execution: { executor: 'claude-acp' }, model: 'external/manual', thinking: 'high' }),
    }));
    expect(navigate.mock.calls[0]?.[1].state).toMatchObject({ model: 'external/manual', thinking: 'high' });
  });

  it('refreshes workspace choices after creation but leaves them unchanged on a failed submit', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent')] });
    const queryClient = await renderDraft();
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);
    const before = client.listWorkspaceCatalog.mock.calls.length;
    client.createSession.mockRejectedValueOnce(new Error('directory unavailable'));
    await act(async () => { await state.send('Start work', []); });
    expect(client.listWorkspaceCatalog).toHaveBeenCalledTimes(before);
    state = await settleDraft((value) => value.error === 'directory unavailable' && !value.busy);
    client.listWorkspaceCatalog.mockResolvedValue({ items: [workspace('wd_new', 'New')] });
    await act(async () => { await state.send('Start work', []); });
    state = await settleDraft((value) => value.workspaces.some((item) => item.id === 'wd_new'));
    expect(queryClient.getQueryData<{ items: { id: string }[] }>(['workspaces', 'catalog'])?.items[0]?.id).toBe('wd_new');
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
    expect(readDraft('session-new')).toBe('Start work');
    expect(readComposerState('session-new').attachments).toEqual([]);
    expect(navigate).toHaveBeenCalledWith('/s/session-new', expect.objectContaining({
      state: expect.objectContaining({ createdSession: { id: 'session-new', scopeId: scope.id }, initialPrompt: 'Start work' }),
    }), expect.any(Function));
  });

  it('uses workspace Git metadata and refreshes it with the workspace list', async () => {
    client.listWorkspaceCatalog.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha')] });
    const queryClient = await renderDraft();
    let state = await settleDraft((value) => !value.workspacesLoading);
    expect(state.worktreeAvailability).toEqual({ kind: 'not-git' });
    expect(client.klient.rest.workspaces.inspect).not.toHaveBeenCalled();
    client.listWorkspaceCatalog.mockResolvedValue({ items: [{ ...workspace('wd_alpha', 'Alpha'), isGit: true }] });
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

  it('keeps a missing profile sendable in an incomplete catalog and continues past two responses', async () => {
    client.listWorkspaceCatalog.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha')] });
    client.listModels.mockResolvedValue({ items: [model('provider/alpha', 'high')] });
    client.listNamedAgentProfiles
      .mockResolvedValueOnce({ items: [profile('agent')], complete: false })
      .mockResolvedValueOnce({ items: [profile('agent')], complete: false })
      .mockResolvedValue({ items: [profile('agent'), profile('workspace-main', 'provider/alpha', 'high')], complete: true });
    await renderDraft({ initialWorkspaceId: 'wd_alpha', initialProfile: 'workspace-main' });
    let state = await settleDraft((value) => value.selectionReady && value.agentProfileCatalogPending);
    client.createSession.mockRejectedValueOnce(new Error('Binding rejected by server'));
    await act(async () => { await state.send('Send the saved choice', []); });
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      agent_config: expect.objectContaining({ profile: 'workspace-main' }),
    }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 270)); });
    expect(client.listNamedAgentProfiles).toHaveBeenCalledTimes(2);
    expect(latestDraftState!.selectionReady).toBe(true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 270)); });
    state = await settleDraft((value) => !value.agentProfileCatalogPending && value.modelOverride === 'provider/alpha');
    expect(client.listNamedAgentProfiles).toHaveBeenCalledTimes(3);
    expect(state.agentProfile).toBe('workspace-main');
    expect(state.effectiveEffort).toBe('high');
  });

  it('sends the preserved initial agent before catalog completion and enriches its workspace pins later', async () => {
    const catalog = deferred<{ items: NamedAgentProfile[] }>();
    client.listWorkspaceCatalog.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha')] });
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
      client.listWorkspaceCatalog.mockResolvedValue({ items: [workspace('wd_beta', 'Beta')] });
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

  it('does not leave a new draft pending when the profile catalog has no default profile', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [] });
    await renderDraft();
    const state = await settleDraft((value) => !value.agentProfileCatalogPending && !value.workspacesLoading);
    expect(state.agentProfileCatalogPending).toBe(false);
    expect(state.busy).toBe(false);
    expect(state.selectionReady).toBe(false);
    await act(async () => { await state.send('No default profile', []); });
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it('keeps the initial selection sendable through a catalog error and background retry', async () => {
    const catalog = deferred<{ items: NamedAgentProfile[] }>();
    client.listWorkspaceCatalog.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha')] });
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
    client.listWorkspaceCatalog.mockResolvedValue({
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
    client.listWorkspaceCatalog.mockResolvedValue({
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
    client.listWorkspaceCatalog.mockResolvedValue({
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
    client.listWorkspaceCatalog.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha')] });
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
    client.listWorkspaceCatalog.mockResolvedValue({
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
    client.listWorkspaceCatalog.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha'), workspace('wd_beta', 'Beta')] });
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
    client.listWorkspaceCatalog.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha'), workspace('wd_beta', 'Beta')] });
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
    client.listWorkspaceCatalog.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha')] });
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
    client.listWorkspaceCatalog.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha')] });
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
    client.listWorkspaceCatalog.mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha')] });
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
    state = await settleDraft((value) => value.agentProfile === 'agent');
    expect(state.modelOverride).toBe('provider/alpha');
    expect(state.effectiveEffort).toBe('low');
    const body = await sentBody(state);
    expect(body.workspace_id).toBeUndefined();
    expect(body.metadata).toBeUndefined();
    expect(body.agent_config).toMatchObject({ profile: 'agent', model: 'provider/alpha', thinking: 'low' });
  });

  it('keeps a deleted workspace id after remount instead of falling back to another workspace', async () => {
    client.listWorkspaceCatalog.mockResolvedValue({
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

    client.listWorkspaceCatalog.mockResolvedValue({ items: [workspace('wd_beta', 'Beta')] });
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

  it('clears selectedPersonaId when switching to a bare execution and does not block send', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent')] });
    client.getPersona.mockResolvedValue({
      definition: { id: 'persona-1', name: 'Persona One', profile: 'agent' },
      systemPrompt: 'prompt',
    });
    await renderDraft({ initialPersona: 'persona-1' });
    let state = await settleDraft((value) => value.persona?.definition.id === 'persona-1' && value.selectionReady);
    expect(state.selectedPersonaId).toBe('persona-1');

    await act(async () => {
      state.setExecution({ executor: 'claude-acp', profile: undefined, profile_file: undefined, overrides: undefined });
    });
    state = latestDraftState!;
    expect(state.selectedPersonaId).toBeUndefined();
    expect(state.persona).toBeUndefined();
    expect(state.selectionReady).toBe(true);
    await act(async () => {
      await state.send('Bare executor sends without blocked persona', []);
    });
    expect(client.createSession).toHaveBeenCalled();
  });

  it('keeps error and blocks send when getPersona fails after changing persona, never reusing old persona', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent')] });
    client.getPersona.mockImplementation(async (id: string) => {
      if (id === 'persona-good') {
        return { definition: { id: 'persona-good', name: 'Good', profile: 'agent' }, systemPrompt: 'good' };
      }
      throw new Error('persona-bad offline');
    });
    await renderDraft({ initialPersona: 'persona-good' });
    let state = await settleDraft((value) => value.persona?.definition.id === 'persona-good' && value.selectionReady);
    expect(state.persona?.definition.id).toBe('persona-good');

    await act(async () => {
      state.selectPersona('persona-bad');
    });
    state = await settleDraft((value) => value.error === 'persona-bad offline' && !value.personaPending);
    expect(state.selectedPersonaId).toBe('persona-bad');
    expect(state.persona).toBeUndefined();
    expect(state.selectionReady).toBe(false);
    await act(async () => {
      void state.send('Must not send with failed persona or impersonate old persona', []);
    });
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it.each(['none', 'model', 'effort', 'both'])('keeps controls picked while the selected persona profile is loading (%s)', async (picked) => {
    const persona = deferred<Awaited<ReturnType<typeof client.getPersona>>>();
    client.getPersona.mockReturnValue(persona.promise);
    client.getConfig.mockResolvedValue({ default_model: 'fixture/default-model' });
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent'), profile('assistant-profile', 'fixture/default-model', 'high')] });
    client.listModels.mockResolvedValue({ items: ['fixture/default-model', 'fixture/selected-model'].map((id) => ({
      ...model(id, 'high'), support_efforts: ['low', 'high'],
    })) });
    await renderDraft({ initialPersona: 'assistant-persona', composer: true });
    await settleDraft((value) => value.personaPending && !value.agentProfileCatalogPending);
    const container = containers.at(-1)!;
    const click = async (selector: string) => {
      const element = container.querySelector(selector);
      expect(element, selector).not.toBeNull();
      await act(async () => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    };
    const modelPicked = picked === 'model' || picked === 'both';
    const effortPicked = picked === 'effort' || picked === 'both';
    if (modelPicked) {
      await click('#composer-execution-select');
      await click('[data-execution-model="fixture/selected-model"]');
    }
    if (effortPicked) {
      await click('#composer-execution-select');
      await click('[data-execution-effort="low"]');
    }
    persona.resolve({ definition: { id: 'assistant-persona', name: 'Assistant', profile: 'assistant-profile' }, systemPrompt: 'Help the user.' });
    const state = await settleDraft((value) => !value.personaPending && value.persona !== undefined);
    expect(state.modelOverride).toBe(modelPicked ? 'fixture/selected-model' : 'fixture/default-model');
    expect(state.effectiveEffort).toBe(effortPicked ? 'low' : 'high');
    const body = await sentBody(state);
    expect(body.agent_config?.model).toBe(modelPicked ? 'fixture/selected-model' : undefined);
    expect(body.agent_config?.thinking).toBe(effortPicked ? 'low' : undefined);
    expect(navigate.mock.calls[0]?.[1].state).toMatchObject({
      model: modelPicked ? 'fixture/selected-model' : undefined, thinking: effortPicked ? 'low' : undefined,
    });
  });

  it.each([false, true])('keeps a named profile chosen after selecting a persona (loaded=%s)', async (loaded) => {
    const persona = deferred<Awaited<ReturnType<typeof client.getPersona>>>();
    client.getPersona.mockReturnValue(persona.promise);
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent'),
      profile('persona-profile', 'fixture/persona-model', 'high'),
      profile('selected-profile', 'fixture/selected-model', 'low'),
    ] });
    client.listModels.mockResolvedValue({ items: [model('fixture/persona-model', 'high'), model('fixture/selected-model', 'low')] });
    await renderDraft({ initialPersona: 'assistant-persona', composer: true });
    await settleDraft((value) => value.personaPending && !value.agentProfileCatalogPending);
    const resolvePersona = () => persona.resolve({ definition: {
      id: 'assistant-persona', name: 'Assistant', profile: 'persona-profile',
    }, systemPrompt: 'Help the user.' });
    if (loaded) {
      resolvePersona();
      await settleDraft((value) => !value.personaPending && value.persona !== undefined);
    }
    const container = containers.at(-1)!;
    const click = async (selector: string) => {
      const element = container.querySelector(selector);
      expect(element, selector).not.toBeNull();
      await act(async () => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    };
    await click('#composer-profile-select');
    await click('[data-execution-profile="selected-profile"]');
    if (!loaded) await act(async () => { resolvePersona(); });
    let state = await settleDraft((value) => !value.personaPending);
    expect(state.selectedPersonaId).toBeUndefined();
    expect(state.persona).toBeUndefined();
    expect(state.agentProfile).toBe('selected-profile');
    expect(state.modelOverride).toBe('fixture/selected-model');
    expect(state.effectiveEffort).toBe('low');
    await unmountDraft();
    await renderDraft({ initialPersona: 'assistant-persona' });
    state = await settleDraft((value) => !value.agentProfileCatalogPending && value.selectionReady);
    expect(client.getPersona).toHaveBeenCalledTimes(1);
    expect(state.agentProfile).toBe('selected-profile');
    expect(state.modelOverride).toBe('fixture/selected-model');
    expect(state.effectiveEffort).toBe('low');
    client.createSession.mockRejectedValueOnce(new ApiError({ code: -2, msg: 'Request timed out', data: null }));
    const body = await sentBody(state);
    expect(body.persona).toBeUndefined();
    expect(body.agent_config).toMatchObject({ profile: 'selected-profile', model: 'fixture/selected-model', thinking: 'low' });
    await settleDraft((value) => !value.creationPending);
    await unmountDraft();
    await renderDraft({ initialPersona: 'assistant-persona' });
    state = await settleDraft((value) => !value.agentProfileCatalogPending && value.selectionReady);
    client.getSessionCreation.mockResolvedValueOnce({ creation_id: body.creation_id!, session_id: `session_${body.creation_id}`, status: 'missing' });
    await act(async () => { await state.retryCreation(); });
    expect(client.createSession.mock.calls[1]![0]).toEqual(body);
    expect(navigate.mock.calls[0]?.[1].state).toMatchObject({ model: 'fixture/selected-model', thinking: 'low' });
    expect(client.getPersona).toHaveBeenCalledTimes(1);
  });

  it.each(['local', 'remote', 'daily'])('restores a profile choice but applies a new persona entry (%s)', async (kind) => {
    if (kind === 'remote') { scope.id = 'ssh:example'; scope.label = 'Example'; }
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent'), profile('persona-profile', 'fixture/persona-model', 'high'), profile('selected-profile', 'fixture/selected-model', 'low')] });
    client.listModels.mockResolvedValue({ items: [model('fixture/persona-model', 'high'), model('fixture/selected-model', 'low')] });
    client.getPersona.mockResolvedValue({ definition: { id: 'assistant-persona', name: 'Assistant', profile: 'persona-profile' } });
    const props = { initialPersona: 'assistant-persona', prefillNavigationKey: 'entry-one', isDailyDraft: kind === 'daily' };
    await renderDraft(props);
    let state = await settleDraft((value) => !value.personaPending && value.persona !== undefined && !value.agentProfileCatalogPending);
    await act(async () => { state.setAgentProfile('selected-profile'); });
    await unmountDraft();
    await renderDraft(props);
    state = await settleDraft((value) => !value.agentProfileCatalogPending);
    expect(state.selectedPersonaId).toBeUndefined();
    expect(state.personaPending).toBe(false);
    expect(state.agentProfile).toBe('selected-profile');
    expect(state.modelOverride).toBe('fixture/selected-model');
    expect(client.getPersona).toHaveBeenCalledTimes(1);
    await unmountDraft();
    await renderDraft({ ...props, prefillNavigationKey: 'entry-two' });
    state = await settleDraft((value) => !value.personaPending && value.persona !== undefined);
    expect(client.getPersona).toHaveBeenCalledTimes(2);
    expect(state.agentProfile).toBe('persona-profile');
    expect(state.modelOverride).toBe('fixture/persona-model');
  });

  it.each([false, true])('resolves per-model effort defaults and preserves manual effort across profile, persona and restore (manual=%s)', async (manual) => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent'), {
      ...profile('assistant-profile', 'fixture/default-model', 'high'),
      model_profiles: [{ alias: 'selected-model', thinking_effort: 'low' }],
    }, { ...profile('next-profile', 'fixture/default-model', 'low'),
      model_profiles: [{ alias: 'selected-model', thinking_effort: 'high' }],
    }] });
    client.listModels.mockResolvedValue({ items: ['fixture/default-model', 'fixture/selected-model'].map((id) => ({
      ...model(id, 'high'), support_efforts: ['low', 'medium', 'high'],
    })) });
    client.getPersona.mockResolvedValue({ definition: { id: 'assistant-persona', name: 'Assistant', profile: 'assistant-profile' } });
    await renderDraft();
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);
    await act(async () => { state.setAgentProfile('assistant-profile'); });
    state = latestDraftState!;
    await act(async () => { if (manual) state.setEffortOverride('medium'); state.setModelOverride('fixture/selected-model'); });
    state = await settleDraft((value) => value.modelOverride === 'fixture/selected-model');
    expect(state.effectiveEffort).toBe(manual ? 'medium' : 'low');
    await act(async () => { state.setAgentProfile('next-profile'); });
    state = latestDraftState!;
    await act(async () => { state.setModelOverride('fixture/selected-model'); });
    state = latestDraftState!;
    expect(state.effectiveEffort).toBe(manual ? 'medium' : 'high');
    await unmountDraft();
    await renderDraft();
    state = await settleDraft((value) => !value.agentProfileCatalogPending);
    expect(state.effectiveEffort).toBe(manual ? 'medium' : 'high');
    await unmountDraft();
    resetDraftMemoryForTests();
    await renderDraft({ initialProfile: 'assistant-profile', prefillNavigationKey: 'new-profile-entry' });
    state = await settleDraft((value) => !value.agentProfileCatalogPending);
    expect(state.effectiveEffort).toBe(manual ? 'medium' : 'high');
    await act(async () => { state.selectPersona('assistant-persona'); });
    state = await settleDraft((value) => !value.personaPending && value.persona !== undefined);
    await act(async () => { state.setModelOverride('fixture/selected-model'); });
    state = latestDraftState!;
    expect(state.effectiveEffort).toBe(manual ? 'medium' : 'low');
    const body = await sentBody(state);
    expect(body.agent_config?.model).toBe('fixture/selected-model');
    expect(body.agent_config?.thinking).toBe(manual ? 'medium' : undefined);
  });

  it.each([false, true])('applies persona effort pins below manual effort and above model-profile defaults after restore (manual=%s)', async (manual) => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent'), {
      ...profile('assistant-profile', 'fixture/default-model', 'low'),
      model_profiles: [{ alias: 'fixture/selected-model', thinking_effort: 'low' }],
    }] });
    client.listModels.mockResolvedValue({ items: ['fixture/default-model', 'fixture/selected-model'].map((id) => ({
      ...model(id, 'medium'), support_efforts: ['low', 'medium', 'high'],
    })) });
    client.getPersona.mockResolvedValue({ definition: {
      id: 'assistant-persona', name: 'Assistant', profile: 'assistant-profile', thinkingEffort: 'high',
    } });
    await renderDraft();
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);
    await act(async () => { if (manual) state.setEffortOverride('medium'); state.setModelOverride('fixture/selected-model'); });
    state = latestDraftState!;
    await act(async () => { state.selectPersona('assistant-persona'); });
    state = await settleDraft((value) => !value.personaPending && value.persona !== undefined);
    expect(state.modelOverride).toBe('fixture/default-model');
    expect(state.effectiveEffort).toBe(manual ? 'medium' : 'high');
    await unmountDraft();
    resetDraftMemoryForTests();
    await renderDraft({ initialPersona: 'assistant-persona' });
    state = await settleDraft((value) => !value.personaPending && value.persona !== undefined && !value.agentProfileCatalogPending);
    await act(async () => { state.setModelOverride('fixture/selected-model'); });
    state = latestDraftState!;
    expect(state.effectiveEffort).toBe(manual ? 'medium' : 'high');
    const body = await sentBody(state);
    expect(body.agent_config?.model).toBe('fixture/selected-model');
    expect(body.agent_config?.thinking).toBe(manual ? 'medium' : undefined);
  });

  it('keeps a real GUI model picker choice after selecting a profile with a model menu', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent'), {
      ...profile('assistant-profile', 'fixture/default-model', 'high'),
      preferred_models: ['fixture/default-model', 'fixture/selected-model'],
      model_profiles: [{ alias: 'fixture/selected-model', thinking_effort: 'high', when: 'Use for an explicitly selected task.' }],
    }] });
    client.listModels.mockResolvedValue({ items: [model('fixture/default-model', 'high'), model('fixture/selected-model', 'high')] });
    await renderDraft({ composer: true });
    await settleDraft((value) => !value.agentProfileCatalogPending);
    const container = containers.at(-1)!;
    const click = async (selector: string) => {
      const element = container.querySelector(selector);
      expect(element, selector).not.toBeNull();
      await act(async () => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    };
    await click('#composer-profile-select');
    await click('[data-execution-profile="assistant-profile"]');
    await settleDraft((value) => value.modelOverride === 'fixture/default-model');
    await click('#composer-execution-select');
    await click('[data-execution-model="fixture/selected-model"]');
    const state = await settleDraft((value) => value.modelOverride === 'fixture/selected-model');
    expect(state.agentProfile).toBe('assistant-profile');
    await act(async () => { state.updateDraft('Keep the model I selected.'); });
    await click('button[aria-label="Send message"]');
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({ agent_config: expect.objectContaining({
      profile: 'assistant-profile', model: 'fixture/selected-model',
    }) }));
    expect(navigate.mock.calls[0]?.[1].state).toMatchObject({ model: 'fixture/selected-model' });
  });

  it('keeps an explicit Sol pick through the profile pin, the parked overrides, and both create hops', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({
      items: [profile('agent', 'kimi-code/kimi-for-coding', 'high')],
    });
    client.listModels.mockResolvedValue({
      items: [
        model('kimi-code/kimi-for-coding', 'high'),
        {
          id: 'axon/gpt-6.1-sol',
          provider_id: 'axon',
          remote_id: 'gpt-6.1-sol',
          max_context_size: 128000,
          support_efforts: ['high', 'xhigh'],
          default_effort: 'high',
        },
      ],
    });
    await renderDraft();
    let state = await settleDraft((value) =>
      !value.agentProfileCatalogPending && value.modelOverride === 'kimi-code/kimi-for-coding');
    await act(async () => {
      state.setModelOverride('axon/gpt-6.1-sol');
      state.setEffortOverride('xhigh');
      state.setExecution({
        executor: 'native',
        profile: 'agent',
        profile_file: undefined,
        overrides: { model: 'axon/gpt-6.1-sol', thinking: 'xhigh' },
      });
    });
    state = latestDraftState!;
    expect(state.modelOverride).toBe('axon/gpt-6.1-sol');
    expect(state.effectiveEffort).toBe('xhigh');
    expect(state.agentProfile).toBe('agent');
    const body = await sentBody(state);
    expect(body.agent_config).toMatchObject({
      profile: 'agent',
      model: 'axon/gpt-6.1-sol',
      thinking: 'xhigh',
    });
    expect(body.agent_config).not.toHaveProperty('execution');
    expect(navigate.mock.calls[0]?.[1].state).toMatchObject({
      model: 'axon/gpt-6.1-sol',
      thinking: 'xhigh',
    });
  });

  it('does not let a late profile pin replace a model chosen before the catalog arrives', async () => {
    const profiles = deferred<{ items: NamedAgentProfile[] }>();
    client.listNamedAgentProfiles.mockReturnValue(profiles.promise);
    client.listModels.mockResolvedValue({
      items: [{
        id: 'axon/gpt-6.1-sol',
        provider_id: 'axon',
        remote_id: 'gpt-6.1-sol',
        max_context_size: 128000,
        support_efforts: ['xhigh'],
        default_effort: 'xhigh',
      }],
    });
    await renderDraft();
    let state = await settleDraft((value) => value.agentProfileCatalogPending);
    await act(async () => {
      state.setModelOverride('axon/gpt-6.1-sol');
      state.setEffortOverride('xhigh');
    });
    profiles.resolve({ items: [profile('agent', 'kimi-code/kimi-for-coding', 'high')] });
    state = await settleDraft((value) => !value.agentProfileCatalogPending && value.selectionReady);
    expect(state.modelOverride).toBe('axon/gpt-6.1-sol');
    expect(state.effectiveEffort).toBe('xhigh');
    const body = await sentBody(state);
    expect(body.agent_config).toMatchObject({
      profile: 'agent',
      model: 'axon/gpt-6.1-sol',
      thinking: 'xhigh',
    });
  });

  it('retains current model selection when switching to a profile without pinned model, but adopts pin when profile has one', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({
      items: [
        profile('agent'),
        { ...profile('no-pin-profile'), pinned_model_alias: undefined, thinking_effort: undefined },
        { ...profile('pinned-profile'), pinned_model_alias: 'fixture/pinned-model', thinking_effort: 'high' },
        { ...profile('foreign-profile'), executor: 'example-acp', pinned_model_alias: undefined, thinking_effort: undefined },
      ],
    });
    client.listModels.mockResolvedValue({
      items: [
        model('fixture/custom-model', 'low'),
        {
          id: 'fixture/pinned-model',
          provider_id: 'fixture',
          remote_id: 'pinned-model',
          max_context_size: 128000,
          support_efforts: ['low', 'high'],
          default_effort: 'low',
        },
      ],
    });
    await renderDraft();
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);

    await act(async () => {
      state.setModelOverride('fixture/custom-model');
    });
    state = latestDraftState!;
    expect(state.modelOverride).toBe('fixture/custom-model');

    await act(async () => {
      state.setAgentProfile('no-pin-profile');
    });
    state = latestDraftState!;
    expect(state.agentProfile).toBe('no-pin-profile');
    expect(state.modelOverride).toBe('fixture/custom-model');

    await act(async () => {
      state.setAgentProfile('pinned-profile');
    });
    state = await settleDraft((value) => value.agentProfile === 'pinned-profile' && value.modelOverride === 'fixture/pinned-model');
    expect(state.effectiveEffort).toBe('high');

    await act(async () => {
      state.setAgentProfile('no-pin-profile');
    });
    state = latestDraftState!;
    expect(state.agentProfile).toBe('no-pin-profile');
    expect(state.modelOverride).toBe('fixture/pinned-model');
    expect(state.effectiveEffort).toBe('low');
    await act(async () => {
      await state.send('Keep the model the previous pin left selected', []);
    });
    const kept = client.createSession.mock.calls[0]![0] as SessionCreate;
    expect(kept.agent_config).toMatchObject({
      profile: 'no-pin-profile',
      model: 'fixture/pinned-model',
      thinking: 'low',
    });

    await act(async () => {
      state.setAgentProfile('foreign-profile');
    });
    state = latestDraftState!;
    expect(state.execution.executor).toBe('example-acp');
    expect(state.modelOverride).toBeUndefined();
    expect(state.effectiveEffort).toBeUndefined();
  });

  it('retains custom model when switching to a profile file without pin after preview resolves', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({
      items: [profile('agent')],
    });
    client.listModels.mockResolvedValue({
      items: [model('fixture/custom-model', 'low')],
    });
    const previewDeferred = deferred<{ profile: NamedAgentProfile }>();
    client.klient.rest.agents.previewFile.mockReturnValue(previewDeferred.promise);

    await renderDraft();
    let state = await settleDraft((value) => !value.agentProfileCatalogPending);

    await act(async () => {
      state.setModelOverride('fixture/custom-model');
    });
    state = latestDraftState!;
    expect(state.modelOverride).toBe('fixture/custom-model');

    await act(async () => {
      state.setExecution({
        executor: 'native',
        profile: undefined,
        profile_file: '/path/to/custom-profile.md',
        overrides: undefined,
      });
    });
    state = latestDraftState!;
    expect(state.execution.profile_file).toBe('/path/to/custom-profile.md');
    expect(state.modelOverride).toBe('fixture/custom-model');

    previewDeferred.resolve({
      profile: {
        ...profile('custom-file-profile'),
        source_file: '/path/to/custom-profile.md',
        pinned_model_alias: undefined,
        thinking_effort: undefined,
      },
    });
    state = await settleDraft((value) =>
      value.execution.profile_file === '/path/to/custom-profile.md'
      && value.selectionReady
      && !value.agentProfileCatalogPending
    );
    expect(state.modelOverride).toBe('fixture/custom-model');

    await act(async () => {
      await state.send('Test message', []);
    });
    const body = client.createSession.mock.calls[0]![0] as SessionCreate;
    expect(body.agent_config).toMatchObject({
      execution: { executor: 'native', profile_file: '/path/to/custom-profile.md' },
      model: 'fixture/custom-model',
    });
    expect(body.agent_config?.model).toBe(state.modelOverride);
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
    // The join is a session fact, while the frozen handoff carries it only as
    // session setup metadata; it must not become first-message content.
    const carried = navigate.mock.calls[0]![1]!.state as Record<string, unknown>;
    expect(carried['sshHosts']).toEqual(hosts);
    expect(navigate).toHaveBeenCalledWith('/s/session-new', expect.objectContaining({ state: expect.objectContaining(kind === 'prompt'
      ? { initialAttachments: [], initialPrompt: 'Inspect' } : { initialSkill: { name: 'inspect', args: '--new\nKeep this line.', attachments: [], userInput: '/inspect --new\nKeep this line.' } }) }), expect.any(Function));
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

  it('applies a pending plugin choice before handing off the first prompt', async () => {
    const capabilityScope: PendingCapabilityScope = { scopeId: scope.id, spaceKey: scope.spaceKey, connectionId: scope.connectionId, draftKey: 'new' };
    setPendingPluginChoice('media', 'on', capabilityScope);
    let accept: (() => void) | undefined;
    client.setPluginUsage.mockImplementation(() => new Promise<void>((resolve) => { accept = resolve; }));
    await renderDraft();
    const state = await settleDraft((value) => value.selectionReady);
    let sending: Promise<void> | undefined;
    await act(async () => { sending = state.send('Create an image', []); });
    await settleDraft(() => client.setPluginUsage.mock.calls.length > 0);
    expect(client.setPluginUsage).toHaveBeenCalledExactlyOnceWith({ target: { session_id: 'session-new' }, plugin_id: 'media', override: 'on' });
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => { accept!(); await sending; });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0]?.[1].state.initialPrompt).toBe('Create an image');
    expect(pendingNewSessionCapabilities(capabilityScope).plugins).toEqual([]);
  });

  it('keeps the draft and the confirmed session when applying a plugin fails, then retries that session', async () => {
    const capabilityScope: PendingCapabilityScope = { scopeId: scope.id, spaceKey: scope.spaceKey, connectionId: scope.connectionId, draftKey: 'new' };
    setPendingPluginChoice('media', 'on', capabilityScope);
    client.setPluginUsage.mockRejectedValueOnce(new Error('Plugin apply failed'));
    await renderDraft();
    let state = await settleDraft((value) => value.selectionReady);
    await act(async () => { state.updateDraft('Use media'); });
    state = latestDraftState!;
    await act(async () => { await state.send('Use media', []); });
    expect(navigate).not.toHaveBeenCalled();
    state = await settleDraft((value) => !value.busy && value.error === 'Plugin apply failed');
    expect(state.draft).toBe('Use media');
    expect(pendingNewSessionCapabilities(capabilityScope).plugins).toEqual([{ pluginId: 'media', override: 'on' }]);
    await act(async () => { await state.send('Use media', []); });
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(client.setPluginUsage).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(pendingNewSessionCapabilities(capabilityScope).plugins).toEqual([]);
  });

  it('applies only this connection and draft, retaining other homes and choices made during apply', async () => {
    const submitted: PendingCapabilityScope = { scopeId: scope.id, spaceKey: scope.spaceKey, connectionId: scope.connectionId, draftKey: 'new' };
    const others: PendingCapabilityScope[] = [
      { ...submitted, spaceKey: 'other-space' },
      { ...submitted, connectionId: 'other-connection' },
      { ...submitted, draftKey: 'persona-daily-example' },
    ];
    setPendingPluginChoice('media', 'on', submitted);
    for (const other of others) setPendingPluginChoice('other-plugin', 'off', other);
    const apply = deferred<object>();
    client.setPluginUsage.mockReturnValue(apply.promise);
    await renderDraft();
    const state = await settleDraft((value) => value.selectionReady);
    let sending: Promise<void> | undefined;
    await act(async () => { sending = state.send('Use media in this draft', []); });
    await settleDraft(() => client.setPluginUsage.mock.calls.length > 0);
    setPendingPluginChoice('media', 'off', submitted);
    await act(async () => { apply.resolve({}); await sending; });
    expect(client.setPluginUsage).toHaveBeenCalledExactlyOnceWith({ target: { session_id: 'session-new' }, plugin_id: 'media', override: 'on' });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(pendingNewSessionCapabilities(submitted).plugins).toEqual([{ pluginId: 'media', override: 'off' }]);
    for (const other of others) expect(pendingNewSessionCapabilities(other).plugins).toEqual([{ pluginId: 'other-plugin', override: 'off' }]);
  });

  it('writes one optional choice before the first prompt and does not write an untouched row', async () => {
    const capabilityScope: PendingCapabilityScope = { scopeId: scope.id, spaceKey: scope.spaceKey, connectionId: scope.connectionId, draftKey: 'new' };
    setPendingOptionalChoice('web', 'off', capabilityScope);
    setPendingOptionalChoice('thread', 'inherit', capabilityScope);
    let accept: (() => void) | undefined;
    client.setSessionOptionalCapability.mockImplementation(() => new Promise<void>((resolve) => { accept = resolve; }));
    await renderDraft();
    const state = await settleDraft((value) => value.selectionReady);
    let sending: Promise<void> | undefined;
    await act(async () => { sending = state.send('Look this up', []); });
    await settleDraft(() => client.setSessionOptionalCapability.mock.calls.length > 0);
    expect(client.setSessionOptionalCapability).toHaveBeenCalledExactlyOnceWith('session-new', { id: 'web', choice: 'off' });
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => { accept!(); await sending; });
    expect(navigate.mock.calls[0]?.[1].state.initialPrompt).toBe('Look this up');
    expect(pendingNewSessionCapabilities(capabilityScope).optional).toBeUndefined();
  });

  it('keeps the draft when an optional choice fails and writes it on retry', async () => {
    const capabilityScope: PendingCapabilityScope = { scopeId: scope.id, spaceKey: scope.spaceKey, connectionId: scope.connectionId, draftKey: 'new' };
    setPendingOptionalChoice('memory', 'on', capabilityScope);
    client.setSessionOptionalCapability.mockRejectedValueOnce(new Error('Optional apply failed'));
    await renderDraft();
    let state = await settleDraft((value) => value.selectionReady);
    await act(async () => { state.updateDraft('Remember this'); });
    state = latestDraftState!;
    await act(async () => { await state.send('Remember this', []); });
    expect(navigate).not.toHaveBeenCalled();
    state = await settleDraft((value) => !value.busy && value.error === 'Optional apply failed');
    expect(state.draft).toBe('Remember this');
    expect(pendingNewSessionCapabilities(capabilityScope).optional).toEqual([{ id: 'memory', choice: 'on' }]);
    await act(async () => { await state.send('Remember this', []); });
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(client.setSessionOptionalCapability).toHaveBeenCalledTimes(2);
    expect(client.setSessionOptionalCapability).toHaveBeenLastCalledWith('session-new', { id: 'memory', choice: 'on' });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(pendingNewSessionCapabilities(capabilityScope).optional).toBeUndefined();
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
      state.setExecution({ executor: 'claude-acp', profile: undefined, profile_file: undefined, overrides: undefined });
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
      state.setExecution({ executor: 'claude-acp', profile: undefined, profile_file: undefined, overrides: undefined });
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
describe('explicit profile file drafts', () => {
  const profile: NamedAgentProfile = {
    name: 'helper', source: 'file', source_file: '/workspace/profiles/helper.md',
    main: false, disabled: false, routes: [], executor: 'native',
    pinned_model_alias: 'fixture/model', thinking_effort: 'high',
  };

  beforeEach(() => {
    client.listModels.mockResolvedValue({ items: [{
      id: 'fixture/model', provider_id: 'fixture', remote_id: 'model',
      support_efforts: ['high'], default_effort: 'high',
    }] });
    client.listNamedAgentProfiles.mockResolvedValue({ items: [] });
    client.klient.rest.agents.previewFile.mockResolvedValue({ profile });
  });

  it('keeps an external file’s vendor model and effort outside Kiki’s model catalog', async () => {
    client.listModels.mockResolvedValue({ items: [] });
    client.klient.rest.agents.previewFile.mockResolvedValue({ profile: { ...profile, executor: 'example-acp', pinned_model_alias: 'vendor-model', thinking_effort: 'vendor-effort' } });
    localStorage.setItem('kiki.newSessionDraft', JSON.stringify({ workspaceId: AUTO_WORKSPACE_ID,
      execution: { executor: 'example-acp', profile_file: profile.source_file }, modelFromProfile: true, effortFromProfile: true,
    }));
    await renderDraft();
    const state = await settleDraft((value) => value.selectionReady && value.modelOverride === 'vendor-model');
    expect(state.effectiveEffort).toBe('vendor-effort');
    await act(async () => { await state.send('Hello', []); });
    const body = client.createSession.mock.calls[0]![0] as SessionCreate;
    expect(body.agent_config).toMatchObject({
      execution: { executor: 'example-acp', profile_file: profile.source_file },
    });
    expect(body.agent_config?.model).toBeUndefined();
    expect(body.agent_config?.thinking).toBeUndefined();
    const handoff = navigate.mock.calls[0]![1].state as Record<string, unknown>;
    expect(handoff['initialPrompt']).toBe('Hello');
    expect(handoff['model']).toBeUndefined();
    expect(handoff['thinking']).toBeUndefined();
  });

  it('sends a model and effort the user touched on an external profile file, on create and the first message', async () => {
    client.listModels.mockResolvedValue({ items: [] });
    client.klient.rest.agents.previewFile.mockResolvedValue({ profile: { ...profile, executor: 'example-acp', pinned_model_alias: 'vendor-model', thinking_effort: 'vendor-effort' } });
    localStorage.setItem('kiki.newSessionDraft', JSON.stringify({ workspaceId: AUTO_WORKSPACE_ID,
      execution: { executor: 'example-acp', profile_file: profile.source_file }, modelFromProfile: true, effortFromProfile: true,
    }));
    await renderDraft();
    let state = await settleDraft((value) => value.selectionReady && value.modelOverride === 'vendor-model');
    await act(async () => { state.setModelOverride('vendor-model'); state.setEffortOverride('vendor-effort'); });
    state = latestDraftState!;
    await act(async () => { await state.send('Hello', []); });
    const body = client.createSession.mock.calls[0]![0] as SessionCreate;
    expect(body.agent_config).toMatchObject({
      execution: { executor: 'example-acp', profile_file: profile.source_file },
      model: 'vendor-model',
      thinking: 'vendor-effort',
    });
    const handoff = navigate.mock.calls[0]![1].state as Record<string, unknown>;
    expect(handoff['initialPrompt']).toBe('Hello');
    expect(handoff['model']).toBe('vendor-model');
    expect(handoff['thinking']).toBe('vendor-effort');
  });

  it('restores a non-main file, previews in its workspace, and creates with its canonical source', async () => {
    client.listWorkspaceCatalog.mockResolvedValue({ items: [{ id: 'workspace-example', root: '/workspace', sessions: 0, lastSessionTime: null }] });
    localStorage.setItem('kiki.newSessionDraft', JSON.stringify({
      workspaceId: 'workspace-example', execution: { executor: 'native', profile_file: 'profiles/helper.md' },
      modelFromProfile: true, effortFromProfile: true,
    }));
    await renderDraft();
    const state = await settleDraft((value) => value.selectionReady && value.modelOverride === 'fixture/model');
    expect(client.klient.rest.agents.previewFile).toHaveBeenCalledWith({ path: 'profiles/helper.md', cwd: undefined, workspace_id: 'workspace-example' }, { signal: expect.any(AbortSignal) });
    expect(state.execution.profile_file).toBe(profile.source_file);
    expect(state.effectiveEffort).toBe('high');
    expect(readStoredDraft()).toMatchObject({ execution: { executor: 'native', profile_file: profile.source_file } });
    await act(async () => { await state.send('Hello', []); });
    expect(client.createSession.mock.calls[0]![0].agent_config.execution).toMatchObject({ executor: 'native', profile_file: profile.source_file });
    expect(client.createSession.mock.calls[0]![0].agent_config.profile).toBeUndefined();
  });

  it.each(['pending', 'failed'])('submits the saved file and manual choices while its preview is %s, retaining the draft on binding failure', async (preview) => {
    if (preview === 'pending') client.klient.rest.agents.previewFile.mockReturnValue(new Promise(() => {}));
    else client.klient.rest.agents.previewFile.mockRejectedValue(new ApiError({ msg: 'Profile could not be loaded', code: 40001, data: null }));
    client.createSession.mockRejectedValueOnce(new Error('Profile binding rejected by server'));
    localStorage.setItem('kiki.newSessionDraft', JSON.stringify({
      workspaceId: AUTO_WORKSPACE_ID,
      execution: { executor: 'native', profile_file: '/workspace/profiles/helper.md' },
      modelOverride: 'fixture/model', effortOverride: 'high', modelFromProfile: false, effortFromProfile: false,
    }));
    await renderDraft();
    const state = await settleDraft((value) => value.selectionReady);
    await act(async () => { state.updateDraft('Keep this draft'); await state.send('Keep this draft', []); });
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({ agent_config: expect.objectContaining({
      execution: expect.objectContaining({ executor: 'native', profile_file: profile.source_file }),
      model: 'fixture/model', thinking: 'high',
    }) }));
    expect(navigate).not.toHaveBeenCalled();
    expect(latestDraftState!.error).toContain('Profile binding rejected by server');
    expect(latestDraftState!.selectionReady).toBe(true);
    expect(readStoredDraft()).toMatchObject({ execution: { profile_file: profile.source_file }, modelOverride: 'fixture/model' });
    expect(latestDraftState!.draft).toBe('Keep this draft');
    expect(latestDraftState!.effectiveEffort).toBe('high');
  });

  it('keeps an explicitly disabled file blocked after preview succeeds', async () => {
    client.klient.rest.agents.previewFile.mockResolvedValue({ profile: { ...profile, disabled: true } });
    localStorage.setItem('kiki.newSessionDraft', JSON.stringify({
      workspaceId: AUTO_WORKSPACE_ID, execution: { executor: 'native', profile_file: profile.source_file },
    }));
    const queryClient = await renderDraft();
    const state = await settleDraft((value) => !value.agentProfileCatalogPending);
    await act(async () => { await state.send('Hello', []); });
    expect(state.selectionReady).toBe(false);
    client.klient.rest.agents.previewFile.mockRejectedValue(new Error('preview offline'));
    await act(async () => { await queryClient.refetchQueries({ queryKey: ['profile-file-preview'] }); });
    await settleDraft((value) => !value.selectionReady);
    await act(async () => { await latestDraftState!.send('Hello', []); });
    expect(client.createSession).not.toHaveBeenCalled();
  });
});

describe('workspace list failures on /new', () => {
  const workspace = (id: string, name: string) => ({
    id,
    name,
    root: `/workspace/${name.toLowerCase()}`,
    pinned: false,
    isGit: false,
    last_opened_at: '2026-09-05T00:00:00.000Z',
    session_count: 0,
  });

  it('reports a failed read instead of reading it as a home with no workspaces', async () => {
    client.listWorkspaceCatalog.mockRejectedValue(new Error('workspace list unavailable'));
    await renderDraft();
    const state = await settleDraft((value) => value.workspacesFailed);

    expect(state.workspaces).toEqual([]);
    expect(state.workspacesError).toBe('workspace list unavailable');
    expect(state.workspacesLoading).toBe(false);
    // A read that never answered cannot decide the target by allocating one.
    expect(state.autoWorkspace).toBe(false);
    expect(state.effectiveWorkspace).toBeUndefined();
    // A non-index failure is not a cold home: it is reported at once, not retried.
    expect(client.listWorkspaceCatalog).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft and the explicit automatic option while the read has failed', async () => {
    client.listWorkspaceCatalog.mockRejectedValue(new Error('workspace list unavailable'));
    await renderDraft();
    const state = await settleDraft((value) => value.workspacesFailed);

    await act(async () => { state.updateDraft('keep this draft'); });
    await act(async () => { latestDraftState!.setCwd('C:/proj'); });
    expect(latestDraftState!.draft).toBe('keep this draft');
    // A typed absolute path still decides the target while the list is broken.
    expect(latestDraftState!.autoWorkspace).toBe(false);

    await act(async () => { latestDraftState!.setCwd(''); });
    await act(async () => { latestDraftState!.selectWorkspace(AUTO_WORKSPACE_ID); });
    expect(latestDraftState!.autoWorkspace).toBe(true);
    expect(latestDraftState!.draft).toBe('keep this draft');
  });

  it('distinguishes an empty home: a resolved empty list is not a failure', async () => {
    client.listWorkspaceCatalog.mockResolvedValue({ items: [] });
    await renderDraft();
    const state = await settleDraft((value) => value.workspacesLoading === false && !value.workspacesFailed);

    expect(state.workspacesFailed).toBe(false);
    expect(state.workspacesError).toBeNull();
    // Automatic allocation is the honest target for a home with no folders yet.
    expect(state.autoWorkspace).toBe(true);
  });

  it('retries a cold index within the shared bounded window, then lists the folder', async () => {
    const building = new ApiError({ code: 40939, msg: 'session index is building', data: null });
    client.listWorkspaceCatalog
      .mockRejectedValueOnce(building)
      .mockResolvedValue({ items: [workspace('wd_alpha', 'Alpha')] });
    await renderDraft();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    const state = await settleDraft((value) => value.workspaces.length > 0);

    expect(client.listWorkspaceCatalog).toHaveBeenCalledTimes(2);
    expect(state.workspacesFailed).toBe(false);
    expect(state.effectiveWorkspace?.id).toBe('wd_alpha');
  });
});

describe('new-session idempotent creation_id intent and error recovery', () => {
  const profile = (name: string, model?: string, thinking?: string): NamedAgentProfile => ({
    name,
    source: 'builtin',
    main: true,
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

  beforeEach(() => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile('agent')] });
    client.listModels.mockResolvedValue({ items: [model('provider/model', 'high')] });
  });

  it('sends lowercase UUID creation_id on create and cleans up intent on successful handoff', async () => {
    await renderDraft();
    const state = await settleDraft((value) => value.selectionReady);
    await act(async () => { await state.send('Normal creation', []); });
    expect(client.createSession).toHaveBeenCalledTimes(1);
    const sent = client.createSession.mock.calls[0]![0] as SessionCreate;
    expect(sent.creation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(readDraft('session-new')).toBe('Normal creation');
    expect(navigate).toHaveBeenCalledWith('/s/session-new', expect.anything(), expect.any(Function));
    expect(localStorage.getItem('kiki.draft.new.intent.local')).toBeNull();
  });

  it('preserves the unknown intent and only GETs while the receipt is pending', async () => {
    client.createSession.mockRejectedValueOnce(new ApiError({
      code: ErrorCode.SESSION_CREATE_OUTCOME_UNKNOWN,
      msg: 'Creation outcome unknown',
      data: null,
      details: { evidence: 'session_present_without_completion' },
    }));

    await renderDraft();
    let state = await settleDraft((value) => value.selectionReady);
    await act(async () => { state.updateDraft('Recover after unknown outcome'); });
    state = latestDraftState!;

    await act(async () => { await state.send(state.draft, []); });
    state = latestDraftState!;
    expect(state.busy).toBe(false);
    expect(state.creationPending).toBe(false);
    expect(state.draft).toBe('Recover after unknown outcome');
    expect(state.creationNotice).toBe('Creation is not confirmed yet. Check the result to continue with the same session. Starting another conversation keeps this attempt for later.');
    expect(client.createSession).toHaveBeenCalledTimes(1);
    const firstCreationId = client.createSession.mock.calls[0]![0].creation_id;
    expect(state.createdSessionId).toBe(`session_${firstCreationId}`);

    client.getSessionCreation.mockResolvedValueOnce({
      creation_id: firstCreationId,
      session_id: `session_${firstCreationId}`,
      status: 'pending',
    });
    await act(async () => { await state.retryCreation(); });
    expect(client.getSessionCreation).toHaveBeenCalledExactlyOnceWith(firstCreationId);
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('retries a receipt the server says is missing with the original id and body', async () => {
    client.createSession.mockRejectedValueOnce(new ApiError({
      code: ErrorCode.SESSION_CREATE_OUTCOME_UNKNOWN,
      msg: 'Creation outcome unknown',
      data: null,
      details: { evidence: 'session_absent' },
    }));

    await renderDraft();
    let state = await settleDraft((value) => value.selectionReady);
    await act(async () => {
      state.updateDraft('Retry after authoritative missing');
      state.setPermissionMode('review');
      state.setPlanMode(true);
    });
    state = latestDraftState!;
    await act(async () => { await state.send(state.draft, []); });
    state = latestDraftState!;
    const firstBody = client.createSession.mock.calls[0]![0] as SessionCreate;
    const creationId = firstBody.creation_id!;

    await act(async () => {
      state.updateDraft('Edited before recovery');
      state.setPermissionMode('yolo');
      state.setPlanMode(false);
    });
    state = latestDraftState!;
    client.getSessionCreation.mockResolvedValueOnce({
      creation_id: creationId,
      session_id: `session_${creationId}`,
      status: 'missing',
    });
    client.createSession.mockResolvedValueOnce({ id: `session_${creationId}` });
    await act(async () => { await state.retryCreation(); });
    expect(client.getSessionCreation).toHaveBeenCalledExactlyOnceWith(creationId);
    expect(client.createSession).toHaveBeenCalledTimes(2);
    expect(client.createSession.mock.calls[1]![0]).toEqual(firstBody);
    expect(navigate).toHaveBeenCalledWith(`/s/session_${creationId}`, expect.anything(), expect.any(Function));
  });

  it.each(['open', 'retry'] as const)('survives refresh with frozen body, handoff, and prompt id, then %s after a completed GET', async (action) => {
    client.createSession.mockRejectedValueOnce(new ApiError({
      code: -2,
      msg: 'Request timed out',
      data: null,
    }));

    const attachment = { kind: 'file' as const, path: '/workspace/input.txt', name: 'input.txt', isDir: false };
    const presentation = { spans: [{ start: 0, end: 8, kind: 'selection' as const, quote: 'Preserve' }] };
    await renderDraft();
    let state = await settleDraft((value) => value.selectionReady);
    await act(async () => {
      state.setCwd('/workspace/original');
      state.updateDraft('Preserve through reload');
      state.setAttachments([attachment]);
      state.setPermissionMode('review');
      state.setPlanMode(true);
    });
    state = await settleDraft((value) => value.cwd === '/workspace/original' && value.draft === 'Preserve through reload');

    await act(async () => { await state.send(state.draft, state.attachments, { presentation }); });
    state = latestDraftState!;
    const firstBody = client.createSession.mock.calls[0]![0] as SessionCreate;
    const creationId = firstBody.creation_id!;
    const initialPromptId = `new-session:${creationId}`;
    expect(state.creationNotice).toContain('Creation is not confirmed yet');
    const persisted = JSON.parse(localStorage.getItem('kiki.draft.new.intent.local') ?? 'null') as Record<string, unknown>;
    expect(persisted['body']).toEqual(firstBody);
    expect(persisted['handoff']).toMatchObject({
      initialPrompt: 'Preserve through reload',
      initialAttachments: [attachment],
      initialPresentation: presentation,
      initialPromptId,
      permissionMode: 'review',
      planMode: true,
    });

    await unmountDraft();
    await renderDraft();
    state = await settleDraft((value) => value.selectionReady);
    expect(state.draft).toBe('Preserve through reload');
    expect(state.creationNotice).toContain('Creation is not confirmed yet');
    expect(state.createdSessionId).toBe(`session_${creationId}`);

    await act(async () => {
      state.updateDraft('Edited after reload');
      state.setCwd('/workspace/changed');
      state.setPermissionMode('yolo');
      state.setPlanMode(false);
    });
    state = latestDraftState!;
    client.getSessionCreation.mockResolvedValueOnce({
      creation_id: creationId,
      session_id: `session_${creationId}`,
      status: 'completed',
      session: { id: `session_${creationId}` },
    });
    await act(async () => {
      if (action === 'open') await state.openCreatedSession();
      else await state.retryCreation();
    });
    expect(client.getSessionCreation).toHaveBeenCalledExactlyOnceWith(creationId);
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(`/s/session_${creationId}`, expect.objectContaining({
      state: expect.objectContaining({
        initialPrompt: 'Preserve through reload',
        initialAttachments: [attachment],
        initialPresentation: presentation,
        initialPromptId,
        permissionMode: 'review',
        planMode: true,
      }),
    }), expect.any(Function));
    expect(state.draft).toBe('Edited after reload');
  });

  it('checks an unconfirmed intent instead of creating a duplicate when the current body changes', async () => {
    client.createSession.mockRejectedValueOnce(new ApiError({
      code: ErrorCode.SESSION_CREATE_OUTCOME_UNKNOWN,
      msg: 'Outcome unknown',
      data: null,
      details: { evidence: 'session_absent' },
    }));

    await renderDraft();
    let state = await settleDraft((value) => value.selectionReady);
    await act(async () => { state.updateDraft('Initial draft'); });
    state = latestDraftState!;

    await act(async () => { await state.send(state.draft, []); });
    expect(client.createSession).toHaveBeenCalledTimes(1);
    const creationId = client.createSession.mock.calls[0]![0].creation_id;

    // Modify draft and cwd to change the body
    await act(async () => {
      state.setCwd('/workspace/different');
      state.updateDraft('Changed draft');
    });
    state = latestDraftState!;

    // A changed body only checks the persisted intent; it cannot silently POST a new request.
    await act(async () => { await state.send(state.draft, []); });
    expect(client.getSessionCreation).toHaveBeenCalledWith(creationId);
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(state.creationNotice).toContain('Creation is not confirmed yet');
    expect(state.draft).toBe('Changed draft');
  });

  it('preserves draft and intent without auto-recreation on 40948 conflict', async () => {
    client.createSession.mockRejectedValueOnce(new ApiError({
      code: ErrorCode.SESSION_CREATE_IDEMPOTENCY_CONFLICT,
      msg: 'Idempotency conflict',
      data: null,
      details: { creation_id: '5d4f1b95-5ad5-4b7f-9a14-28ad2f8d1c42', reason: 'body_mismatch' },
    }));

    await renderDraft();
    let state = await settleDraft((value) => value.selectionReady);
    await act(async () => { state.updateDraft('Conflict body'); });
    state = latestDraftState!;

    await act(async () => { await state.send(state.draft, []); });
    state = latestDraftState!;
    expect(state.error).toContain('40948');
    expect(state.draft).toBe('Conflict body');
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });
});


describe('new-session creation recovery at the component boundary', () => {
  beforeEach(() => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [{ name: 'agent', source: 'builtin', main: true, disabled: false, routes: [] }] });
    client.klient.rest.ssh.addSessionHost.mockReset().mockResolvedValue({});
  });

  const ready = () => settleDraft((value) => value.selectionReady && !value.agentProfileCatalogPending);
  const storedIntent = (key = 'local') => JSON.parse(localStorage.getItem(`kiki.draft.new.intent.${key}`) ?? 'null') as {
    creationId: string; sessionId: string; bodyKey: string; status: string; evidence?: string; reason?: string;
  } | null;

  it('remounts while POST is still held, restores the exact pending identity, and only replays after a missing receipt', async () => {
    const gate = deferred<{ id: string }>();
    client.createSession.mockReturnValueOnce(gate.promise);
    await renderDraft();
    let state = await ready();
    await act(async () => { state.setCwd('/workspace/original'); state.updateDraft('Keep the in-flight draft'); });
    state = await ready();
    let original: Promise<void> | undefined;
    await act(async () => { original = state.send(state.draft, []); });
    const firstBody = client.createSession.mock.calls[0]![0] as SessionCreate;
    const sessionId = `session_${firstBody.creation_id}`;
    expect(storedIntent()).toMatchObject({ creationId: firstBody.creation_id, sessionId, status: 'pending' });
    expect(JSON.parse(storedIntent()!.bodyKey)).toEqual(['local', { ...firstBody, creation_id: undefined }]);
    // The request has not resolved or rejected, and the draft is already durable.
    expect(JSON.parse(localStorage.getItem('kiki.drafts') ?? '{}').new).toBe('Keep the in-flight draft');
    await unmountDraft();
    resetDraftMemoryForTests();
    await renderDraft();
    state = await ready();
    expect(state.createdSessionId).toBe(sessionId);
    expect(state.creationNotice).toContain('Creation is not confirmed yet');
    expect(state.creationPending).toBe(false);
    expect(state.draft).toBe('Keep the in-flight draft');
    expect(state.cwd).toBe('/workspace/original');
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => { await state.send(state.draft, []); });
    expect(client.getSessionCreation).toHaveBeenCalledExactlyOnceWith(firstBody.creation_id);
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();

    client.getSessionCreation.mockResolvedValueOnce({
      creation_id: firstBody.creation_id!, session_id: sessionId, status: 'missing',
    });
    client.createSession.mockResolvedValueOnce({ id: sessionId });
    await act(async () => { await state.retryCreation(); });
    expect(client.createSession.mock.calls[1]![0]).toEqual(firstBody);
    expect(navigate).toHaveBeenCalledTimes(1);
    await act(async () => { gate.resolve({ id: sessionId }); await original; });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(storedIntent()).toBeNull();
  });

  it.each([
    undefined,
    'session_absent',
    'session_present_without_completion',
    'completion_receipt_write_failed',
    'session_read_error',
    'receipt_read_error',
    'future_diagnostic_evidence',
  ])('keeps timeout/50006 evidence %s unknown and only retries after the receipt says missing', async (evidence) => {
    client.createSession.mockRejectedValueOnce(new ApiError({
      code: evidence === undefined ? -2 : ErrorCode.SESSION_CREATE_OUTCOME_UNKNOWN,
      msg: 'Unconfirmed creation', data: null, details: { evidence },
    }));
    await renderDraft();
    let state = await ready();
    await act(async () => { state.updateDraft('Retry this same request'); });
    state = latestDraftState!;
    await act(async () => { await state.send(state.draft, []); });
    state = latestDraftState!;
    const firstBody = client.createSession.mock.calls[0]![0] as SessionCreate;
    const creationId = firstBody.creation_id!;
    expect(state.creationNotice).toContain('Creation is not confirmed yet');
    expect(storedIntent()?.status).toBe('unknown');
    expect(storedIntent()?.evidence).toBe(evidence);
    expect(navigate).not.toHaveBeenCalled();

    const missing = evidence === 'session_absent';
    client.getSessionCreation.mockResolvedValueOnce({
      creation_id: creationId,
      session_id: `session_${creationId}`,
      status: missing ? 'missing' : 'pending',
    });
    if (missing) client.createSession.mockResolvedValueOnce({ id: `session_${creationId}` });
    await act(async () => { await state.retryCreation(); });
    expect(client.getSessionCreation).toHaveBeenCalledExactlyOnceWith(creationId);
    if (missing) {
      expect(client.createSession).toHaveBeenCalledTimes(2);
      expect(client.createSession.mock.calls[1]![0]).toEqual(firstBody);
    } else {
      expect(client.createSession).toHaveBeenCalledTimes(1);
      expect(navigate).not.toHaveBeenCalled();
    }
  });

  it.each(['unknown', 'body_mismatch', 'session_id_exists'])('does not turn a cancelled %s result or a later body change into acceptance', async (result) => {
    const gate = deferred<{ id: string }>();
    client.createSession.mockReturnValueOnce(gate.promise);
    await renderDraft();
    let state = await ready();
    await act(async () => { state.updateDraft('Keep the cancelled draft'); });
    state = latestDraftState!;
    let sending: Promise<void> | undefined;
    await act(async () => { sending = state.send(state.draft, []); });
    await act(async () => { latestDraftState!.cancelCreation(); });
    await act(async () => {
      gate.reject(new ApiError({
        code: result === 'unknown' ? ErrorCode.SESSION_CREATE_OUTCOME_UNKNOWN : ErrorCode.SESSION_CREATE_IDEMPOTENCY_CONFLICT,
        msg: 'Creation did not confirm acceptance', data: null,
        details: result === 'unknown' ? { evidence: 'receipt_read_error' } : { reason: result },
      }));
      await sending;
    });
    state = latestDraftState!;
    if (result === 'unknown') expect(state.creationNotice).toContain('Creation is not confirmed yet');
    else expect(state.creationNotice).toBeNull();
    expect(state.creationNotice ?? '').not.toContain('The session was created');
    expect(storedIntent()).toMatchObject({ status: result === 'unknown' ? 'unknown' : 'conflict' });
    if (result !== 'unknown') expect(storedIntent()?.reason).toBe(result);
    await act(async () => { state.setCwd('/workspace/changed'); state.updateDraft('Keep the edited draft'); });
    state = await ready();
    if (result !== 'unknown') {
      client.getSessionCreation.mockRejectedValueOnce(new ApiError({ code: ErrorCode.SESSION_CREATE_IDEMPOTENCY_CONFLICT, msg: 'Creation receipt unavailable', data: null }));
    }
    await act(async () => { await state.send(state.draft, []); });
    state = latestDraftState!;
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(state.creationNotice ?? '').not.toContain('The session was created');
    expect(state.draft).toBe('Keep the edited draft');
    expect(navigate).not.toHaveBeenCalled();
    await unmountDraft();
    resetDraftMemoryForTests();
    await renderDraft();
    state = await ready();
    expect(state.creationNotice ?? '').not.toContain('The session was created');
    if (result !== 'unknown') {
      expect(state.error).toContain('40948');
      expect(state.createdSessionId).toBeUndefined();
      await act(async () => { await state.openCreatedSession(); });
      expect(navigate).not.toHaveBeenCalled();
    }
  });

  it('does not let a late response from a cancelled attempt affect a new attempt', async () => {
    const oldCreation = deferred<{ id: string }>();
    const newCreation = deferred<{ id: string }>();
    client.createSession.mockReturnValueOnce(oldCreation.promise).mockReturnValueOnce(newCreation.promise);
    await renderDraft();
    let state = await ready();
    await act(async () => { state.updateDraft('Old attempt'); });
    state = latestDraftState!;
    let oldSubmission: Promise<unknown> | undefined;
    await act(async () => { oldSubmission = state.send(state.draft, []); });
    const oldBody = client.createSession.mock.calls[0]![0] as SessionCreate;
    await act(async () => { latestDraftState!.cancelCreation(); });
    expect(latestDraftState?.creationPending).toBe(false);
    expect(latestDraftState?.busy).toBe(false);

    await act(async () => { latestDraftState!.startNewCreation(); });
    state = latestDraftState!;
    expect(state.hasCreationIntent).toBe(false);
    expect(state.createdSessionId).toBeUndefined();
    await act(async () => { state.updateDraft('New attempt'); });
    state = latestDraftState!;
    let newSubmission: Promise<unknown> | undefined;
    await act(async () => { newSubmission = state.send(state.draft, []); });
    const newBody = client.createSession.mock.calls[1]![0] as SessionCreate;
    expect(newBody.creation_id).not.toBe(oldBody.creation_id);
    expect(latestDraftState?.creationPending).toBe(true);
    expect(latestDraftState?.busy).toBe(true);

    await act(async () => { oldCreation.resolve({ id: `session_${oldBody.creation_id}` }); await oldSubmission; });
    state = latestDraftState!;
    expect(state.createdSessionId).toBeUndefined();
    expect(state.creationPending).toBe(true);
    expect(state.busy).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    expect(storedIntent()).toMatchObject({ creationId: newBody.creation_id, status: 'pending' });

    await act(async () => { newCreation.resolve({ id: `session_${newBody.creation_id}` }); await newSubmission; });
    expect(navigate).toHaveBeenCalledWith(`/s/session_${newBody.creation_id}`, expect.anything(), expect.any(Function));
    expect(navigate).not.toHaveBeenCalledWith(`/s/session_${oldBody.creation_id}`, expect.anything(), expect.anything());
  });

  it('can recover the previous attempt after starting another conversation and refreshing', async () => {
    const oldCreation = deferred<{ id: string }>();
    client.createSession.mockReturnValueOnce(oldCreation.promise);
    await renderDraft();
    let state = await ready();
    await act(async () => { state.updateDraft('Original frozen message'); });
    let sending: Promise<void> | undefined;
    await act(async () => { sending = latestDraftState!.send('Original frozen message', []); });
    const oldBody = client.createSession.mock.calls[0]![0] as SessionCreate;
    await act(async () => { latestDraftState!.cancelCreation(); latestDraftState!.startNewCreation(); });
    await act(async () => { oldCreation.resolve({ id: `session_${oldBody.creation_id}` }); await sending; });
    expect(navigate).not.toHaveBeenCalled();
    await unmountDraft();
    resetDraftMemoryForTests();
    await renderDraft();
    state = await ready();
    expect(state.hasPreviousCreation).toBe(true);
    await act(async () => { state.restorePreviousCreation(); });
    state = latestDraftState!;
    expect(state.createdSessionId).toBe(`session_${oldBody.creation_id}`);
    await act(async () => { await state.openCreatedSession(); });
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(`/s/session_${oldBody.creation_id}`, expect.objectContaining({ state: expect.objectContaining({ initialPrompt: 'Original frozen message', initialPromptId: `new-session:${oldBody.creation_id}` }) }), expect.any(Function));
  });

  it('clears a definite create failure instead of recovering it as an unknown pending request on reload', async () => {
    client.createSession.mockRejectedValueOnce(new ApiError({ code: 40001, msg: 'Invalid creation', data: null }));
    await renderDraft();
    let state = await ready();
    await act(async () => { state.updateDraft('Correct the request'); });
    await act(async () => { await latestDraftState!.send('Correct the request', []); });
    expect(storedIntent()).toBeNull();
    await unmountDraft();
    resetDraftMemoryForTests();
    await renderDraft();
    state = await ready();
    expect(state.creationNotice).toBeNull();
    expect(state.createdSessionId).toBeUndefined();
    expect(state.draft).toBe('Correct the request');
  });

  it('dismisses an accepted intent on reload once the conversation has been opened', async () => {
    // The user created a session, sent the first message, and came back to
    // /new: the accepted intent is done, not a notice to keep showing.
    const creationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const sessionId = `session_${creationId}`;
    localStorage.setItem('kiki.draft.new.intent.local', JSON.stringify({
      creationId, sessionId, bodyKey: '["local",{}]', status: 'accepted',
    }));
    client.getSessionCreation.mockReset().mockResolvedValue({
      creation_id: creationId, session_id: sessionId, status: 'completed',
      session: { id: sessionId, message_count: 2 },
    });
    await renderDraft();
    let state = await ready();
    expect(state.creationNotice).toBeNull();
    expect(state.hasCreationIntent).toBe(false);
    expect(state.createdSessionId).toBeUndefined();
    expect(storedIntent()).toBeNull();
    // An accepted session with no messages yet was never opened: the recovery
    // entry stays, now backed by the server receipt.
    await unmountDraft();
    resetDraftMemoryForTests();
    localStorage.setItem('kiki.draft.new.intent.local', JSON.stringify({
      creationId, sessionId, bodyKey: '["local",{}]', status: 'accepted',
    }));
    client.getSessionCreation.mockReset().mockResolvedValue({
      creation_id: creationId, session_id: sessionId, status: 'completed',
      session: { id: sessionId, message_count: 0 },
    });
    await renderDraft();
    state = await ready();
    expect(state.creationNotice).toContain('The session was created');
    expect(state.hasCreationIntent).toBe(true);
    expect(storedIntent()?.status).toBe('accepted');
  });

  it('dismisses a recovery entry on demand and keeps it dismissed', async () => {
    const creationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    localStorage.setItem('kiki.draft.new.intent.local', JSON.stringify({
      creationId, sessionId: `session_${creationId}`, bodyKey: '["local",{}]', status: 'unknown',
    }));
    await renderDraft();
    let state = await ready();
    expect(state.creationNotice).toContain('Creation is not confirmed yet');
    expect(state.hasCreationIntent).toBe(true);
    await act(async () => { state.dismissCreationIntent(); });
    state = latestDraftState!;
    expect(state.creationNotice).toBeNull();
    expect(state.hasCreationIntent).toBe(false);
    expect(state.createdSessionId).toBeUndefined();
    expect(storedIntent()).toBeNull();
    await unmountDraft();
    resetDraftMemoryForTests();
    await renderDraft();
    state = await ready();
    expect(state.creationNotice).toBeNull();
    expect(state.hasCreationIntent).toBe(false);
  });

  it('does not keep an accepted attempt as a restorable previous creation', async () => {
    const creationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const sessionId = `session_${creationId}`;
    localStorage.setItem('kiki.draft.new.intent.local', JSON.stringify({
      creationId, sessionId, bodyKey: '["local",{}]', status: 'accepted',
    }));
    client.getSessionCreation.mockReset().mockResolvedValue({
      creation_id: creationId, session_id: sessionId, status: 'completed',
      session: { id: sessionId, message_count: 0 },
    });
    await renderDraft();
    let state = await ready();
    expect(state.creationNotice).toContain('The session was created');
    expect(state.hasPreviousCreation).toBe(false);
    await act(async () => { state.startNewCreation(); });
    state = latestDraftState!;
    expect(state.creationNotice).toBeNull();
    expect(state.hasCreationIntent).toBe(false);
    expect(state.hasPreviousCreation).toBe(false);
    expect(localStorage.getItem('kiki.draft.new.intent.local:previous')).toBeNull();
    expect(storedIntent()).toBeNull();
  });

  it('isolates connection identities in one home without importing the legacy local draft', async () => {
    writeDraft('new', 'Legacy local draft');
    flushDrafts();
    const gate = deferred<{ id: string }>();
    scope.id = 'direct:https://one.example.test';
    client.createSession.mockReturnValueOnce(gate.promise);
    await renderDraft();
    let state = await ready();
    expect(state.draft).toBe('');
    await act(async () => { state.setCwd('/workspace/one'); state.updateDraft('Connection one draft'); });
    state = await ready();
    let sending: Promise<void> | undefined;
    await act(async () => { sending = state.send(state.draft, []); });
    const first = client.createSession.mock.calls[0]![0] as SessionCreate;
    await unmountDraft();
    resetDraftMemoryForTests();
    scope.id = 'direct:https://two.example.test';
    await renderDraft();
    state = await ready();
    expect(state.creationNotice).toBeNull();
    expect(state.createdSessionId).toBeUndefined();
    expect(state.draft).toBe('');
    expect(state.cwd).toBe('');
    expect(client.createSession).toHaveBeenCalledTimes(1);
    await unmountDraft();
    resetDraftMemoryForTests();
    scope.id = 'direct:https://one.example.test';
    await renderDraft();
    state = await ready();
    expect(state.createdSessionId).toBe(`session_${first.creation_id}`);
    expect(state.draft).toBe('Connection one draft');
    expect(state.cwd).toBe('/workspace/one');
    await act(async () => { gate.resolve({ id: `session_${first.creation_id}` }); await sending; });
    expect(navigate).not.toHaveBeenCalled();
    expect(readDraft('new')).toBe('Legacy local draft');
  });

  it('keeps a late creation result in its captured home rather than the newly active home', async () => {
    const gate = deferred<{ id: string }>();
    client.createSession.mockReturnValueOnce(gate.promise);
    await renderDraft();
    let state = await ready();
    await act(async () => { state.updateDraft('Main home draft'); });
    let sending: Promise<void> | undefined;
    await act(async () => { sending = latestDraftState!.send('Main home draft', []); });
    await unmountDraft();
    configureSpaceStorage({ homeId: 'other-home' });
    scope.spaceKey = 'other-home';
    resetDraftMemoryForTests();
    await renderDraft();
    state = await ready();
    expect(state.createdSessionId).toBeUndefined();
    expect(state.draft).toBe('');
    await act(async () => { gate.resolve({ id: 'session-main-home' }); await sending; });
    expect(localStorage.getItem('kiki.space.other-home.kiki.draft.new.intent.local')).toBeNull();
    expect(storedIntent()).toMatchObject({ status: 'accepted', sessionId: 'session-main-home' });
    expect(latestDraftState!.createdSessionId).toBeUndefined();
    expect(navigate).not.toHaveBeenCalled();
    await unmountDraft();
    configureSpaceStorage(null);
    scope.spaceKey = 'local-space';
    resetDraftMemoryForTests();
    await renderDraft();
    state = await ready();
    expect(state.createdSessionId).toBe('session-main-home');
    expect(state.draft).toBe('Main home draft');
  });

  it('retains existing local and persona daily draft keys and keeps their pending identities separate', async () => {
    const dailyKey = personaDailyDraftKey('local', 'example-persona');
    writeDraft('new', 'Local draft');
    writeDraft(dailyKey, 'Daily draft');
    flushDrafts();
    localStorage.setItem(personaDailySettingsKey('local', 'example-persona'), JSON.stringify({ cwd: '/workspace/daily' }));
    client.getPersona.mockResolvedValue({ definition: { id: 'example-persona', name: 'Example persona' } });
    const gate = deferred<{ id: string }>();
    client.createSession.mockReturnValueOnce(gate.promise);
    await renderDraft({ initialPersona: 'example-persona', isDailyDraft: true });
    let state = await ready();
    expect(state.draft).toBe('Daily draft');
    expect(state.cwd).toBe('/workspace/daily');
    let sending: Promise<void> | undefined;
    await act(async () => { sending = state.send(state.draft, []); });
    const first = client.createSession.mock.calls[0]![0] as SessionCreate;
    expect(first).toMatchObject({ persona: 'example-persona', persona_home: true });
    await unmountDraft();
    resetDraftMemoryForTests();
    await renderDraft();
    state = await ready();
    expect(state.draft).toBe('Local draft');
    expect(state.createdSessionId).toBeUndefined();
    await unmountDraft();
    resetDraftMemoryForTests();
    await renderDraft({ initialPersona: 'example-persona', isDailyDraft: true });
    state = await ready();
    expect(state.createdSessionId).toBe(`session_${first.creation_id}`);
    expect(state.draft).toBe('Daily draft');
    await act(async () => { gate.resolve({ id: `session_${first.creation_id}` }); await sending; });
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    ['ssh', ErrorCode.SESSION_CREATE_OUTCOME_UNKNOWN],
    ['optional', -2],
    ['navigation', ErrorCode.SESSION_CREATE_IDEMPOTENCY_CONFLICT],
  ] as const)('retains accepted identity after %s error %s, including remount and retry', async (phase, code) => {
    const failure = new ApiError({ code, msg: `${phase} failed after creation`, data: null });
    const hosts = [{ kind: 'ssh' as const, id: 'example-host', name: 'Example host' }];
    if (phase === 'ssh') client.klient.rest.ssh.addSessionHost.mockRejectedValueOnce(failure);
    if (phase === 'optional') {
      setPendingOptionalChoice('memory', 'on', { scopeId: scope.id, spaceKey: scope.spaceKey, connectionId: scope.connectionId, draftKey: 'new' });
      client.setSessionOptionalCapability.mockRejectedValueOnce(failure);
    }
    if (phase === 'navigation') navigate.mockRejectedValueOnce(failure);
    await renderDraft();
    let state = await ready();
    await act(async () => { state.updateDraft('Keep the accepted session'); });
    await act(async () => { await latestDraftState!.send('Keep the accepted session', phase === 'ssh' ? hosts : []); });
    state = latestDraftState!;
    expect(state.creationNotice).toContain('The session was created');
    expect(state.createdSessionId).toBe('session-new');
    expect(state.draft).toBe('Keep the accepted session');
    expect(storedIntent()).toMatchObject({ status: 'accepted', sessionId: 'session-new' });
    await unmountDraft();
    resetDraftMemoryForTests();
    await renderDraft();
    state = await ready();
    expect(state.createdSessionId).toBe('session-new');
    expect(state.creationNotice).toContain('The session was created');
    navigate.mockResolvedValue(undefined);
    await act(async () => { await state.send(state.draft, phase === 'ssh' ? hosts : []); });
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenLastCalledWith('/s/session-new', expect.objectContaining({ state: expect.objectContaining({ initialPrompt: 'Keep the accepted session' }) }), expect.any(Function));
  });

  it('keeps persistence explicitly off through a held create and the first-message handoff', async () => {
    localStorage.setItem('kiki.settings', JSON.stringify({ draftPersistence: false }));
    const gate = deferred<{ id: string }>();
    client.createSession.mockReturnValueOnce(gate.promise);
    await renderDraft();
    let state = await ready();
    await act(async () => { state.updateDraft('Memory-only first message'); });
    state = latestDraftState!;
    let sending: Promise<void> | undefined;
    await act(async () => { sending = state.send(state.draft, [{ kind: 'file', path: '/workspace/input.txt', name: 'input.txt', isDir: false }]); });
    expect(storedIntent()).toBeNull();
    expect(localStorage.getItem('kiki.drafts')).toBeNull();
    await act(async () => { gate.resolve({ id: 'session-memory-only' }); await sending; });
    expect(readDraft('session-memory-only')).toBe('Memory-only first message');
    expect(localStorage.getItem('kiki.drafts')).toBeNull();
    expect(localStorage.getItem('kiki.composerStates') ?? '').not.toContain('input.txt');
    expect(storedIntent()).toBeNull();
  });
});

describe('new-session real dirty navigation handoff', () => {
  it.each(['declarative', 'data'] as const)('retains the accepted identity and draft while %s navigation waits, cancels, then confirms a retry', async (mode) => {
    const { useDirtyGuardState } = await vi.importActual<typeof import('./dirtyGuard')>('./dirtyGuard');
    let guard!: ReturnType<typeof useDirtyGuardState>;
    let observedPath = '/new';
    function GuardedHarness() {
      const location = useLocation();
      const rawNavigate = useNavigate();
      observedPath = location.pathname;
      guard = useDirtyGuardState(location, (target, options) => typeof target === 'number'
        ? rawNavigate(target) : rawNavigate(target, options));
      latestDraftState = useNewSessionDraft();
      return null;
    }
    navigate.mockImplementation((...args: Parameters<typeof guard.navigate>) => guard.navigate(...args));
    client.listNamedAgentProfiles.mockResolvedValue({ items: [{ name: 'agent', source: 'builtin', main: true, disabled: false, routes: [] }] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClients.push(queryClient);
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const router = mode === 'data' ? createMemoryRouter([
      { path: '/new', element: createElement(GuardedHarness) },
      { path: '/s/:id', element: createElement('div', null, 'Created session') },
    ], { initialEntries: ['/new'] }) : undefined;
    const content = router === undefined
      ? createElement(MemoryRouter, { initialEntries: ['/new'] }, createElement(GuardedHarness))
      : createElement(RouterProvider, { router });
    try {
      await act(async () => {
        root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(I18nProvider, null, content)));
      });
      let state = await settleDraft((value) => value.selectionReady && !value.agentProfileCatalogPending);
      await act(async () => {
        guard.value.reportDirty('example-editor', true);
        state.updateDraft('Keep this until navigation is confirmed');
      });
      let submission: Promise<void> | undefined;
      let settled = false;
      await act(async () => {
        submission = latestDraftState!.send('Keep this until navigation is confirmed', []);
        void submission?.then(() => { settled = true; });
      });
      await settleDraft(() => guard.pending);
      expect(settled).toBe(false);
      expect(readDraft('new')).toBe('Keep this until navigation is confirmed');
      expect(JSON.parse(localStorage.getItem('kiki.draft.new.intent.local') ?? 'null')).toMatchObject({ status: 'accepted', sessionId: 'session-new' });
      expect(router?.state.location.pathname ?? observedPath).toBe('/new');
      await act(async () => { guard.cancel(); await submission; });
      state = latestDraftState!;
      expect(state.creationPending).toBe(false);
      expect(state.busy).toBe(false);
      expect(state.error).toBeNull();
      expect(state.creationNotice).toContain('The session was created');
      expect(readDraft('new')).toBe('Keep this until navigation is confirmed');
      expect(JSON.parse(localStorage.getItem('kiki.draft.new.intent.local') ?? 'null')).toMatchObject({ status: 'accepted', sessionId: 'session-new' });
      expect(router?.state.location.pathname ?? observedPath).toBe('/new');
      await act(async () => { submission = state.send(state.draft, []); });
      await settleDraft(() => guard.pending);
      expect(client.createSession).toHaveBeenCalledTimes(1);
      await act(async () => { await guard.confirm(); await submission; });
      expect(router?.state.location.pathname ?? observedPath).toBe('/s/session-new');
      expect(readDraft('new')).toBe('');
      expect(localStorage.getItem('kiki.draft.new.intent.local')).toBeNull();
    } finally {
      await unmountDraft();
      router?.dispose();
    }
  });
});

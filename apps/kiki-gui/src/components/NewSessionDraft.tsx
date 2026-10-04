/**
 * NewSessionDraft — the workspace/cwd picker state behind the /new full-page
 * draft, the only new-session surface. The hook owns draft persistence
 * (`lib/drafts.ts` key "new"), model/permission state, and the
 * create-then-navigate send path. A slash skill on /new rides the same
 * navigation as a first prompt (`initialSkill`); SessionView activates it
 * after the live controller subscribes.
 *
 * The /new page does not render the Composer here: it registers this state
 * into the conversation shell's composer seat (see NewSessionPage), so the
 * textarea survives the hero → session transition.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AuthSummary,
  NamedAgentProfile,
  PermissionMode,
  PersonaSnapshot,
  SessionCreate,
  Workspace,
} from '@kiki/protocol';

import {
  buildPromptContent,
  clearNewSessionDraft,
  flushDrafts,
  readDraft,
  readNewSessionDraft,
  writeDraft,
  writeNewSessionDraft,
  type ComposerAttachment,
  type PersistedNewSessionDraft,
  type SshHostAttachment,
} from '@kiki/session-core/composer';
import { sortWorkspacesByPinnedThenRecency, sortWorkspacesByRecency } from '@kiki/session-core/sessions';
import {
  composerDefaultsForProfile,
  projectedProfileModelState,
  readSettings,
  resolveCatalogModel,
  resolveEffectiveModel,
  resolveModelSource,
  resolveSelectedEffort,
  resolveSessionModelOverride,
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
} from '@kiki/session-core/settings';
import { DEFAULT_AGENT_PROFILE } from './Composer';
import { personaDailyDraftKey, personaDailySettingsKey } from './persona/personaNavigation';
import { useHost } from '../host';
import {
  agentProfileCatalogQueryKey,
  loadAgentProfileCatalog,
  type AgentProfileCatalogMode,
} from '../lib/agentProfileCatalog';
import { useGuardedNavigate } from './dirtyGuard';
import { runNewSessionHandoff } from '../lib/newSessionHandoff';
import { spaceStorage } from '../lib/spaceStorage';
import { SearchableSelect, type SearchableSelectOption } from './SearchableSelect';
import { useI18n } from '../i18n';
import { errorText } from '@kiki/session-core/i18n';
import { pushToast } from '../lib/toasts';
import { useWorktreeAvailability, workspaceGitState } from '../lib/worktrees';
import { useConnection } from '../state/connection';
import { sshApi, sshKeys } from '../lib/ssh';

const DRAFT_KEY = 'new';
const remoteDraftStorageKey = (scopeId: string) => `kiki.draft.new.${scopeId}`;

/**
 * A daily draft keeps its own target and settings. Sharing the /new key would
 * hand persona B the project persona A had picked for its daily conversation.
 */
function readDailyDraftSettings(storageKey: string): PersistedNewSessionDraft {
  if (!readSettings().draftPersistence) return {};
  try {
    const value = JSON.parse(spaceStorage.getItem(storageKey) ?? '{}') as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    return {
      workspaceId: typeof record['workspaceId'] === 'string' ? record['workspaceId'] : undefined,
      cwd: typeof record['cwd'] === 'string' ? record['cwd'] : undefined,
      profile: typeof record['profile'] === 'string' ? record['profile'] : undefined,
      modelOverride: typeof record['modelOverride'] === 'string' ? record['modelOverride'] : undefined,
      effortOverride: typeof record['effortOverride'] === 'string' ? record['effortOverride'] : undefined,
      modelFromProfile: typeof record['modelFromProfile'] === 'boolean' ? record['modelFromProfile'] : undefined,
      effortFromProfile: typeof record['effortFromProfile'] === 'boolean' ? record['effortFromProfile'] : undefined,
      prefillSource: typeof record['prefillSource'] === 'string' ? record['prefillSource'] : undefined,
    };
  } catch {
    return {};
  }
}

function writeDailyDraftSettings(storageKey: string, draft: PersistedNewSessionDraft): void {
  if (!readSettings().draftPersistence) return;
  try {
    spaceStorage.setItem(storageKey, JSON.stringify(draft));
  } catch {
    return;
  }
}

function readScopedNewSessionDraft(scopeId: string): PersistedNewSessionDraft {
  if (scopeId === 'local' || !readSettings().draftPersistence) return scopeId === 'local' ? readNewSessionDraft() : {};
  try {
    const value = JSON.parse(spaceStorage.getItem(remoteDraftStorageKey(scopeId)) ?? '{}') as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    return {
      workspaceId: typeof record['workspaceId'] === 'string' ? record['workspaceId'] : undefined,
      cwd: typeof record['cwd'] === 'string' ? record['cwd'] : undefined,
      profile: typeof record['profile'] === 'string' ? record['profile'] : undefined,
      modelOverride: typeof record['modelOverride'] === 'string' ? record['modelOverride'] : undefined,
      effortOverride: typeof record['effortOverride'] === 'string' ? record['effortOverride'] : undefined,
      modelFromProfile: typeof record['modelFromProfile'] === 'boolean' ? record['modelFromProfile'] : undefined,
      effortFromProfile: typeof record['effortFromProfile'] === 'boolean' ? record['effortFromProfile'] : undefined,
      prefillSource: typeof record['prefillSource'] === 'string' ? record['prefillSource'] : undefined,
    };
  } catch {
    return {};
  }
}

function writeScopedNewSessionDraft(scopeId: string, draft: PersistedNewSessionDraft): void {
  if (scopeId === 'local') return writeNewSessionDraft(draft);
  if (!readSettings().draftPersistence) return;
  try {
    spaceStorage.setItem(remoteDraftStorageKey(scopeId), JSON.stringify(draft));
  } catch {
    return;
  }
}

function clearScopedNewSessionDraft(scopeId: string): void {
  if (scopeId === 'local') return clearNewSessionDraft();
  try { spaceStorage.removeItem(remoteDraftStorageKey(scopeId)); } catch { return; }
}

export const AUTO_WORKSPACE_ID = '__auto__';

// The temporary choice survives navigating back to /new, but not a window restart.
let ephemeralForWindow = false;

/** Test seam: a fresh window's temporary choice. */
export function resetEphemeralChoiceForTests(): void {
  ephemeralForWindow = false;
}

/** One-shot skill activation carried across the /new → /s/:id navigation. */
export interface DraftSkillHandoff {
  readonly name: string;
  readonly args: string;
  readonly attachments: readonly ComposerAttachment[];
  readonly userInput?: string;
}

/** Hosts preselected on /new, split off before anything becomes a message. */
function sshOf(attachments: readonly ComposerAttachment[]): readonly SshHostAttachment[] {
  return attachments.filter((item): item is SshHostAttachment => item.kind === 'ssh');
}

/** Everything a message carries: a joined host is session state, not content. */
function withoutSsh(attachments: readonly ComposerAttachment[]): readonly ComposerAttachment[] {
  return attachments.filter((item) => item.kind !== 'ssh');
}

/** Build the create-time execution configuration applied before the first handoff runs. */
export function buildNewSessionCreate(input: {
  readonly cwd: string;
  readonly workspaceId?: string;
  readonly profile: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
  /** Opt-in only: run in a fresh Kiki-managed worktree of the target repository. */
  readonly worktree?: boolean;
  readonly ephemeral?: boolean;
  /**
   * Bind a persona. Its own profile then applies (the profile field is left
   * out so the server does not override it with the default), and model /
   * thinking are sent only when the user picked them after the persona.
   */
  readonly persona?: string;
  /** Whether this session creation claims the persona's fixed daily conversation entrance (D3) */
  readonly personaHome?: boolean;
}): SessionCreate {
  const persona = input.persona === undefined ? {} : { persona: input.persona, ...(input.personaHome ? { persona_home: true } : {}) };
  const agent_config = {
    ...(input.persona === undefined ? { profile: input.profile } : {}),
    model: input.model,
    thinking: input.thinking,
    permission_mode: input.permissionMode,
    plan_mode: input.planMode,
  };
  const isolation = input.worktree === true ? { isolation: { kind: 'worktree' as const } } : {};
  return input.cwd !== ''
    ? { metadata: { cwd: input.cwd }, ...persona, agent_config, ...isolation, ephemeral: input.ephemeral }
    : { workspace_id: input.workspaceId, ...persona, agent_config, ...isolation, ephemeral: input.ephemeral };
}

/** Whether a bound persona shows a greeting the first message would answer. */
export function hasGreeting(persona: PersonaSnapshot | undefined): boolean {
  return persona?.definition.greeting !== undefined && persona.definition.greeting.trim() !== '';
}

/**
 * Basic absolute-path check for the free-text cwd field, across platforms:
 * POSIX `/…`, Windows drive `C:\…` / `C:/…`, or UNC `\\server\…`. Relative
 * paths are rejected — the server would resolve them against its own cwd,
 * which is never what the user meant.
 */
export function isAbsoluteCwdPath(value: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(value);
}

export function isAbsoluteRemoteCwdPath(value: string): boolean {
  return value.startsWith('/') && !value.includes('\0') && !value.includes('\\');
}

/**
 * Whether /new should offer first-run provider guidance. True only when both
 * probes have answered and agree there is nothing to answer with — an
 * in-flight or failed probe stays silent, because a card that flashes on
 * every visit costs more than a late one.
 */
export function needsProviderSetup(
  auth: AuthSummary | undefined,
  models: readonly unknown[] | undefined,
): boolean {
  if (auth === undefined || models === undefined) return false;
  return !auth.ready && models.length === 0;
}

export function useNewSessionDraft({
  initialWorkspaceId,
  initialProfile,
  initialPersona,
  isDailyDraft,
  prefillNavigationKey,
}: {
  initialWorkspaceId?: string;
  /** `?agent=` prefill — the profile the new session binds at creation. */
  initialProfile?: string;
  /** `?persona=` prefill — the persona the new session binds at creation. */
  initialPersona?: string;
  /** When true, marks this session draft as the persona's daily conversation, claiming the pointer on first send. */
  isDailyDraft?: boolean;
  /** Router history-entry identity survives reload/back but changes on a new navigation. */
  prefillNavigationKey?: string;
} = {}) {
  const host = useHost();
  const queryClient = useQueryClient();
  const { client, scopeId, sshLabel } = useConnection();
  const draftScopeId = sshLabel === null ? 'local' : scopeId;
  /**
   * A daily draft is the persona's, not the shared `/new` scratch pad: its own
   * text and its own target, keyed by connection scope and persona so two
   * personas (or one persona over SSH and locally) never read each other's.
   */
  const dailyPersonaId = isDailyDraft === true ? initialPersona : undefined;
  const dailySettingsKey = dailyPersonaId === undefined
    ? undefined
    : personaDailySettingsKey(scopeId, dailyPersonaId);
  const draftKey = dailyPersonaId !== undefined
    ? personaDailyDraftKey(scopeId, dailyPersonaId)
    : draftScopeId === 'local' ? DRAFT_KEY : `${DRAFT_KEY}:${draftScopeId}`;
  const navigate = useGuardedNavigate();
  const { t, locale } = useI18n();
  const liveSettings = useSyncExternalStore(
    subscribeSettings,
    settingsSnapshot,
    settingsServerSnapshot,
  );
  const settings = useMemo(() => readSettings(), []);
  const initialRestoredDraft = useMemo(
    () => (dailySettingsKey === undefined ? readScopedNewSessionDraft(draftScopeId) : readDailyDraftSettings(dailySettingsKey)),
    [dailySettingsKey, draftScopeId],
  );
  const [prefillSource] = useState(() => initialWorkspaceId !== undefined || initialProfile !== undefined
    ? JSON.stringify([initialWorkspaceId ?? null, initialProfile ?? null, prefillNavigationKey ?? null])
    : initialRestoredDraft.prefillSource);
  const applyPrefill = prefillSource !== initialRestoredDraft.prefillSource;

  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [workspaceId, setWorkspaceId] = useState(
    (applyPrefill ? initialWorkspaceId : undefined) ?? initialRestoredDraft.workspaceId ?? '',
  );
  const [cwd, setCwd] = useState(
    applyPrefill && initialWorkspaceId !== undefined ? '' : (initialRestoredDraft.cwd ?? ''),
  );
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(settings.defaultPermissionMode);
  const [planMode, setPlanMode] = useState(settings.defaultPlanMode);
  const [goalObjective, setGoalObjective] = useState('');
  // Never persisted: every new draft starts in the current checkout.
  const [worktreeRequested, setWorktreeRequested] = useState(false);
  // Remembered for this window only, so a new window never starts temporary
  // without the user choosing it again.
  const [ephemeral, setEphemeralState] = useState(ephemeralForWindow);
  const setEphemeral = useCallback((value: boolean) => {
    ephemeralForWindow = value;
    setEphemeralState(value);
  }, []);
  const [modelOverride, setModelOverrideState] = useState(() =>
    resolveSessionModelOverride(initialRestoredDraft.modelOverride),
  );
  const [agentProfile, setAgentProfileState] = useState(
    (applyPrefill ? initialProfile : undefined) ?? initialRestoredDraft.profile ?? DEFAULT_AGENT_PROFILE,
  );
  // The visible effort follows the catalog for ordinary drafts. A persona's
  // inherited preview is not a user override, even when it has the same value.
  const [effortOverride, setEffortOverrideState] = useState<string | undefined>(
    initialRestoredDraft.effortOverride,
  );
  // The persona bound at creation. Kept for this window only (like the
  // temporary choice); `?persona=` prefills it from the Personas page.
  const [persona, setPersonaState] = useState<PersonaSnapshot | undefined>(undefined);
  const [personaPending, setPersonaPending] = useState(initialPersona !== undefined);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [profileCatalogTransitionPending, setProfileCatalogTransitionPending] = useState(false);
  const profileCatalogTransitionRef = useRef(false);
  const hasNewProfilePrefill = applyPrefill && initialProfile !== undefined;
  const modelOverrideFromProfile = useRef(hasNewProfilePrefill || (initialRestoredDraft.modelFromProfile ?? initialRestoredDraft.profile === undefined));
  const effortOverrideFromProfile = useRef(hasNewProfilePrefill || (initialRestoredDraft.effortFromProfile ?? initialRestoredDraft.profile === undefined));
  const modelOverrideFromPersona = useRef(false);
  const effortOverrideFromPersona = useRef(false);

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    staleTime: 30_000,
  });
  const workspaces = workspacesQuery.data?.items ?? [];
  const workspacesLoading = workspacesQuery.isLoading;

  const effectiveWorkspace: Workspace | undefined = useMemo(
    () =>
      workspaceId === '' ? (dailyPersonaId === undefined ? sortWorkspacesByRecency(workspaces)[0] : undefined)
        : workspaceId === AUTO_WORKSPACE_ID ? undefined
        : workspaces.find((w) => w.id === workspaceId),
    [dailyPersonaId, workspaces, workspaceId],
  );
  const autoWorkspace = cwd.trim() === '' && effectiveWorkspace === undefined
    && (workspaceId === '' || workspaceId === AUTO_WORKSPACE_ID);
  const worktreeRoot = cwd.trim() !== ''
    ? (isAbsoluteCwdPath(cwd.trim()) ? cwd.trim() : undefined)
    : effectiveWorkspace?.root;
  const worktreeAvailability = useWorktreeAvailability(client, {
    root: worktreeRoot,
    remote: sshLabel !== null,
    isGit: workspaceGitState(worktreeRoot, workspaces),
  });
  const worktree = worktreeRequested && worktreeAvailability.kind === 'ready';

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });
  const serverDefaultModel = configQuery.data?.default_model || undefined;

  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: () => client.listModels(),
    staleTime: 60_000,
  });
  const agentProfileCatalogMode = useMemo<AgentProfileCatalogMode>(() => {
    const directory = cwd.trim();
    if (directory !== '') return isAbsoluteCwdPath(directory)
      ? { mode: 'cwd', cwd: directory, effective: true }
      : { mode: 'disabled' };
    if (effectiveWorkspace !== undefined) {
      return { mode: 'workspace', workspaceId: effectiveWorkspace.id, effective: true };
    }
    return workspaceId === '' || workspaceId === AUTO_WORKSPACE_ID
      ? { mode: 'unscoped' }
      : { mode: 'disabled' };
  }, [cwd, effectiveWorkspace, workspaceId]);
  const agentProfilesQuery = useQuery({
    queryKey: agentProfileCatalogQueryKey(agentProfileCatalogMode),
    queryFn: () => loadAgentProfileCatalog(client, agentProfileCatalogMode),
    enabled: agentProfileCatalogMode.mode !== 'disabled',
    staleTime: 60_000,
    retry: false,
  });
  // First-run readiness: a fresh install has no provider and no model, so the
  // first send would fail deep in the turn. Shares the settings page's query
  // keys so the two surfaces never disagree.
  const authQuery = useQuery({
    queryKey: ['auth'],
    queryFn: () => client.getAuth(),
    staleTime: 10_000,
    retry: false,
  });
  const providerSetupNeeded = needsProviderSetup(authQuery.data, modelsQuery.data?.items);
  // Server default first — the local mirror only fills in when the server
  // has not reported one (matches the session page).
  const inheritedDefault = serverDefaultModel ?? liveSettings.defaultModel;
  const effectiveModel = resolveEffectiveModel(modelOverride, undefined, inheritedDefault);
  const modelSource = resolveModelSource(
    modelOverride,
    undefined,
    liveSettings.defaultModel,
    serverDefaultModel,
  );
  const selectedProfile = agentProfilesQuery.data?.items.find((item) => item.name === agentProfile);
  const modelProjectionState = projectedProfileModelState(selectedProfile, modelsQuery.data?.items ?? [], effectiveModel, 'main');
  const catalogItem = effectiveModel === undefined ? undefined : resolveCatalogModel(modelsQuery.data?.items ?? [], effectiveModel);
  const supportedEfforts = catalogItem?.support_efforts;
  const effectiveEffort = effortOverride ?? resolveSelectedEffort(
    supportedEfforts,
    undefined,
    catalogItem?.default_effort,
  );

  useEffect(() => {
    setDraft(readDraft(draftKey));
    return () => { flushDrafts(); };
  }, [draftKey]);

  const setModelOverride = useCallback((model: string | undefined) => {
    modelOverrideFromPersona.current = false;
    modelOverrideFromProfile.current = false;
    setModelOverrideState(model);
    setSelectionRevision((value) => value + 1);
  }, []);
  const setEffortOverride = useCallback((thinking: string | undefined) => {
    effortOverrideFromPersona.current = false;
    effortOverrideFromProfile.current = false;
    setEffortOverrideState(thinking);
    setSelectionRevision((value) => value + 1);
  }, []);
  const applyAgentProfile = useCallback((
    items: readonly NamedAgentProfile[],
    name: string,
  ) => {
    const defaults = composerDefaultsForProfile(items, name);
    setAgentProfileState(name);
    modelOverrideFromPersona.current = false;
    effortOverrideFromPersona.current = false;
    modelOverrideFromProfile.current = true;
    effortOverrideFromProfile.current = true;
    setModelOverrideState(defaults.model);
    setEffortOverrideState(defaults.thinking);
    setSelectionRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    if (agentProfileCatalogMode.mode !== 'disabled' && agentProfilesQuery.isPending) return;
    const profiles = agentProfilesQuery.data?.items;
    const selected = profiles?.find((item) =>
      item.name === agentProfile && item.main === true && !item.disabled
    );
    // Errors and confirmed-invalid selections are different states. Neither
    // authorizes replacing the user's choice (or its persisted source).
    if (!agentProfilesQuery.isError && selected !== undefined && profiles !== undefined) {
      const defaults = composerDefaultsForProfile(profiles, agentProfile);
      if (modelOverrideFromProfile.current) setModelOverrideState(defaults.model);
      if (effortOverrideFromProfile.current) setEffortOverrideState(defaults.thinking);
    }
    profileCatalogTransitionRef.current = false;
    setProfileCatalogTransitionPending(false);
  }, [agentProfile, agentProfileCatalogMode, agentProfilesQuery.data, agentProfilesQuery.isError, agentProfilesQuery.isPending]);

  useEffect(() => {
    if (dailySettingsKey !== undefined) {
      writeDailyDraftSettings(dailySettingsKey, {
        workspaceId: workspaceId || effectiveWorkspace?.id,
        cwd,
        profile: agentProfile,
        modelOverride: modelOverrideFromPersona.current ? undefined : modelOverride,
        effortOverride: effortOverrideFromPersona.current ? undefined : effortOverride,
        modelFromProfile: modelOverrideFromProfile.current || modelOverrideFromPersona.current,
        effortFromProfile: effortOverrideFromProfile.current || effortOverrideFromPersona.current,
        prefillSource,
      });
      return;
    }
    writeScopedNewSessionDraft(draftScopeId, {
      workspaceId: workspaceId || effectiveWorkspace?.id,
      cwd,
      profile: agentProfile,
      modelOverride: modelOverrideFromPersona.current ? undefined : modelOverride,
      effortOverride: effortOverrideFromPersona.current ? undefined : effortOverride,
      modelFromProfile: modelOverrideFromProfile.current || modelOverrideFromPersona.current,
      effortFromProfile: effortOverrideFromProfile.current || effortOverrideFromPersona.current,
      prefillSource,
    });
  }, [dailySettingsKey, draftScopeId, workspaceId, effectiveWorkspace?.id, cwd, agentProfile, modelOverride, effortOverride, selectionRevision, prefillSource]);

  // A daily draft starts in the persona's own workspace when the persona names
  // one and the user has not already chosen for this draft. A directory the
  // user is still choosing from (or one that has failed) decides nothing.
  const dailyDefaultApplied = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (dailyPersonaId === undefined || persona === undefined) return;
    if (persona.definition.id !== dailyPersonaId) return;
    if (dailyDefaultApplied.current === dailyPersonaId) return;
    if (workspacesQuery.isPending) return;
    dailyDefaultApplied.current = dailyPersonaId;
    if (workspaceId !== '' || cwd.trim() !== '') return;
    const home = persona.definition.homeWorkspace;
    if (home === undefined) return;
    const named = workspaces.find((workspace) => workspace.id === home)
      ?? workspaces.find((workspace) => workspace.root === home);
    if (named !== undefined) {
      setWorkspaceId(named.id);
      return;
    }
    if (isAbsoluteCwdPath(home)) setCwd(home);
  }, [cwd, dailyPersonaId, persona, workspaceId, workspaces, workspacesQuery.isPending]);

  const updateDraft = useCallback((text: string) => {
    setDraft(text);
    writeDraft(draftKey, text);
  }, [draftKey]);

  const agentProfileCatalogPending = profileCatalogTransitionPending
    || (cwd.trim() === '' && workspacesQuery.isPending)
    || (agentProfileCatalogMode.mode !== 'disabled' && agentProfilesQuery.isPending);
  const selectionBlocked = agentProfileCatalogMode.mode === 'disabled'
    || agentProfilesQuery.isError
    || !agentProfilesQuery.data?.items.some((item) => item.name === agentProfile && item.main === true && !item.disabled)
    || !modelsQuery.isSuccess
    || modelProjectionState === 'blocked' || modelProjectionState === 'unknown'
    || (effectiveModel !== undefined && catalogItem === undefined)
    || (effortOverride !== undefined && catalogItem !== undefined && !supportedEfforts?.includes(effortOverride));

  // Refs keep the send path stable across renders: the /new page publishes a
  // memoized composer element into the conversation shell, and a send that
  // changes identity on every keystroke would defeat the memo.
  const sendContextRef = useRef({
    busy: busy || selectionBlocked || personaPending,
    agentProfileCatalogPending,
    cwd,
    effectiveWorkspace,
    modelOverride: persona !== undefined && (modelOverrideFromProfile.current || modelOverrideFromPersona.current) ? undefined : modelOverride,
    effectiveEffort: persona !== undefined && (effortOverrideFromProfile.current || effortOverrideFromPersona.current) ? undefined : effectiveEffort,
    agentProfile,
    permissionMode,
    planMode,
    goalObjective,
    worktree,
    ephemeral,
    persona,
  });
  sendContextRef.current = {
    busy: busy || selectionBlocked || personaPending,
    agentProfileCatalogPending,
    cwd,
    effectiveWorkspace,
    modelOverride: persona !== undefined && (modelOverrideFromProfile.current || modelOverrideFromPersona.current) ? undefined : modelOverride,
    effectiveEffort: persona !== undefined && (effortOverrideFromProfile.current || effortOverrideFromPersona.current) ? undefined : effectiveEffort,
    agentProfile,
    permissionMode,
    planMode,
    goalObjective,
    worktree,
    ephemeral,
    persona,
  };

  const createdForRetry = useRef<{ body: string; sessionId: string } | undefined>(undefined);
  const createThenNavigate = useCallback((handoff: {
    initialPrompt?: string;
    initialAttachments?: readonly ComposerAttachment[];
    initialSkill?: DraftSkillHandoff;
    /**
     * Hosts preselected on /new. They are session resources, not message
     * content, so they ride the create request (joined before the first
     * prompt) and never the prompt itself.
     */
    sshHosts?: readonly SshHostAttachment[];
    /**
     * A `/goal …` prefix send carries its objective out-of-band: the draft
     * state only catches up on the next render, which is too late for the
     * handoff below.
     */
    goalObjectiveOverride?: string;
  }) => {
    const context = sendContextRef.current;
    if (context.busy || context.agentProfileCatalogPending || profileCatalogTransitionRef.current) {
      return;
    }
    const trimmedCwd = context.cwd.trim();
    // A free-text cwd must be an absolute path — a relative one would be
    // resolved against the server's own cwd and silently land elsewhere.
    if (trimmedCwd !== '' && (sshLabel === null ? !isAbsoluteCwdPath(trimmedCwd) : !isAbsoluteRemoteCwdPath(trimmedCwd))) {
      setError(sshLabel === null ? t('new.cwdInvalid') : t('connect.sshCwdInvalid'));
      return;
    }
    setBusy(true);
    setError(null);

    const body = buildNewSessionCreate({
      cwd: trimmedCwd,
      workspaceId: context.effectiveWorkspace?.id,
      profile: context.agentProfile,
      model: context.modelOverride,
      thinking: context.effectiveEffort,
      permissionMode: context.permissionMode,
      planMode: context.planMode,
      worktree: context.worktree,
      ephemeral: context.ephemeral || undefined,
      persona: context.persona?.definition.id,
      personaHome: isDailyDraft,
    });

    // Returned so the composer's send latch rides the create round trip: a
    // second trigger while this is in flight is ignored, and a failed create
    // releases the latch for retry.
    const bodyKey = JSON.stringify([draftScopeId, body]);
    const retry = createdForRetry.current;
    const creation = retry?.body === bodyKey ? Promise.resolve({ id: retry.sessionId }) : client.createSession(body);
    return creation
      .then(async (session) => {
        void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
        createdForRetry.current = { body: bodyKey, sessionId: session.id };
        // Hosts preselected on /new become session resources before anything
        // is sent: the real PUT lands first, and a failure here aborts the
        // navigation instead of delivering a first message that believes it
        // has hosts the session does not have.
        for (const host of handoff.sshHosts ?? []) {
          try {
            await sshApi(client).addSessionHost(session.id, host.id);
          } catch (cause: unknown) {
            pushToast({
              tone: 'error',
              text: t('composer.ssh.addFailed', { name: host.name, detail: errorText(locale, cause) }),
            });
            throw cause;
          }
        }
        createdForRetry.current = undefined;
        writeDraft(draftKey, '');
        clearScopedNewSessionDraft(draftScopeId);
        // Creation already confirmed this target in this connection scope.
        // Let the route mount immediately while its guard revalidates it.
        queryClient.setQueryData(['space-view-target', scopeId, 'session', session.id], true);
        // react-router's navigate returns a promise in data routers; the
        // navigation is fire-and-forget here (the catch below covers createSession).
        // The hand-off motion rides along with it and never delays the send.
        runNewSessionHandoff({
          text: handoff.initialPrompt,
          navigate: () => navigate(`/s/${session.id}`, {
            state: {
              createdSession: { id: session.id, scopeId },
              initialPrompt: handoff.initialPrompt,
              initialAttachments: handoff.initialAttachments,
              initialSkill: handoff.initialSkill,
              model: context.modelOverride,
              thinking: context.effectiveEffort,
              permissionMode: context.permissionMode,
              planMode: context.planMode,
              goalObjective: handoff.goalObjectiveOverride ?? context.goalObjective,
              // The greeting was the last thing on screen and this is the first
              // message: the engine materializes it as history from the frozen
              // persona (the client never sends the greeting text itself).
              personaGreetingReply: handoff.initialPrompt !== undefined && hasGreeting(context.persona) ? true : undefined,
            },
            replace: false,
          }),
        });
      })
      .catch((error: unknown) => {
        setBusy(false);
        setError(error instanceof Error ? error.message : String(error));
      });
  }, [client, draftKey, draftScopeId, locale, scopeId, sshLabel, navigate, queryClient, t]);

  const send = useCallback((
    text: string,
    composerAttachments: readonly ComposerAttachment[],
    options?: { readonly goalObjective?: string },
  ) => {
    if (buildPromptContent(text, composerAttachments) === null) return;
    if (options?.goalObjective !== undefined) setGoalObjective(options.goalObjective);
    return createThenNavigate({
      initialPrompt: text.trim(),
      initialAttachments: withoutSsh(composerAttachments),
      sshHosts: sshOf(composerAttachments),
      goalObjectiveOverride: options?.goalObjective,
    });
  }, [createThenNavigate]);

  const activateSkill = useCallback((
    name: string,
    args: string,
    composerAttachments: readonly ComposerAttachment[],
    userInput?: string,
  ) => {
    return createThenNavigate({
      initialSkill: { name, args, attachments: withoutSsh(composerAttachments), userInput },
      sshHosts: sshOf(composerAttachments),
    });
  }, [createThenNavigate]);

  const beginProfileCatalogTransition = useCallback(() => {
    profileCatalogTransitionRef.current = true;
    setProfileCatalogTransitionPending(true);
  }, []);
  const selectWorkspace = useCallback((nextId: string) => {
    if (nextId === workspaceId && (nextId === '' || cwd === '')) return;
    beginProfileCatalogTransition();
    setWorkspaceId(nextId);
    if (nextId !== '') setCwd('');
  }, [beginProfileCatalogTransition, cwd, workspaceId]);
  const updateCwd = useCallback((nextCwd: string) => {
    if (nextCwd === cwd) return;
    beginProfileCatalogTransition();
    setCwd(nextCwd);
  }, [beginProfileCatalogTransition, cwd]);

  /**
   * Native folder picker (desktop only). A picked folder lands in the cwd
   * field rather than creating a workspace up front: the session's own
   * creation registers it, so cancelling out of /new leaves no debris.
   */
  const browseForWorkspace = useCallback(async () => {
    try {
      const picked = await host.pickDirectory?.();
      if (picked === undefined || picked === null) return;
      beginProfileCatalogTransition();
      setWorkspaceId('');
      setCwd(picked);
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [beginProfileCatalogTransition, host]);

  const setAgentProfile = useCallback((name: string) => {
    const items = agentProfilesQuery.data?.items;
    if (items === undefined) return;
    const profile = items.find((item) => item.name === name && item.main === true && !item.disabled);
    if (profile === undefined) return;
    applyAgentProfile(items, profile.name);
  }, [agentProfilesQuery.data, applyAgentProfile]);

  /**
   * Bind (or clear) a persona. Its profile becomes the draft's profile so the
   * catalog check and capability panel describe what will run, and its model
   * and effort pins replace the composer's model and effort, exactly like
   * picking a pinned profile. Clearing drops back to the default profile.
   */
  const applyPersona = useCallback((snapshot: PersonaSnapshot | undefined) => {
    const items = agentProfilesQuery.data?.items ?? [];
    setPersonaState(snapshot);
    if (snapshot === undefined) {
      applyAgentProfile(items, DEFAULT_AGENT_PROFILE);
      return;
    }
    const definition = snapshot.definition;
    const profile = definition.profile ?? DEFAULT_AGENT_PROFILE;
    const defaults = composerDefaultsForProfile(items, profile);
    setAgentProfileState(profile);
    // Persona pins preview the effective values without becoming explicit
    // request overrides. Unpinned values continue following the profile.
    modelOverrideFromPersona.current = definition.modelAlias !== undefined;
    effortOverrideFromPersona.current = definition.thinkingEffort !== undefined;
    modelOverrideFromProfile.current = definition.modelAlias === undefined;
    effortOverrideFromProfile.current = definition.thinkingEffort === undefined;
    setModelOverrideState(definition.modelAlias ?? defaults.model);
    setEffortOverrideState(definition.thinkingEffort ?? defaults.thinking);
    setSelectionRevision((value) => value + 1);
  }, [agentProfilesQuery.data, applyAgentProfile]);

  // A persona read that lands after a newer pick has committed must not speak
  // for the newer pick: two slower/faster round trips are not a user's order.
  const personaSelectionRef = useRef(0);
  const selectPersona = useCallback((id: string | undefined) => {
    const token = personaSelectionRef.current + 1;
    personaSelectionRef.current = token;
    if (id === undefined) { applyPersona(undefined); return; }
    setPersonaPending(true);
    void client.getPersona(id)
      .then((snapshot) => { if (personaSelectionRef.current === token) applyPersona(snapshot); })
      .catch((cause: unknown) => {
        if (personaSelectionRef.current !== token) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => { if (personaSelectionRef.current === token) setPersonaPending(false); });
  }, [applyPersona, client]);

  // `?persona=` from the Personas page's "Start a chat" — applied once the
  // profile catalog is there, so the persona's profile validates.
  const initialPersonaRef = useRef(initialPersona);
  useEffect(() => {
    const id = initialPersonaRef.current;
    if (id === undefined || agentProfilesQuery.data === undefined) return;
    initialPersonaRef.current = undefined;
    selectPersona(id);
  }, [agentProfilesQuery.data, selectPersona]);

  return {
    persona,
    personaPending,
    selectPersona,
    /** Set when this draft is one persona's daily conversation. */
    dailyPersonaId,
    /** Its name, for the hero's identity line and the workspace chip's auto label. */
    dailyPersonaName: dailyPersonaId !== undefined && persona?.definition.id === dailyPersonaId ? persona.definition.name : undefined,
    draft,
    attachments,
    busy,
    error,
    workspaceId,
    cwd,
    permissionMode,
    planMode,
    goalObjective,
    modelOverride,
    agentProfile,
    workspaces,
    workspacesLoading,
    effectiveWorkspace,
    autoWorkspace,
    worktreeAvailability,
    worktreeRequested,
    setWorktreeRequested,
    ephemeral,
    setEphemeral,
    agentProfileCatalogMode,
    agentProfileCatalogPending,
    needsProviderSetup: providerSetupNeeded,
    sshLabel,
    canBrowseForWorkspace: sshLabel === null && host.pickDirectory !== undefined,
    browseForWorkspace,
    serverDefaultModel,
    inheritedDefault,
    modelSource,
    supportedEfforts,
    effectiveEffort,
    updateDraft,
    setAttachments,
    selectWorkspace,
    setCwd: updateCwd,
    setPermissionMode,
    setPlanMode,
    setGoalObjective,
    setModelOverride,
    setAgentProfile,
    setEffortOverride,
    send,
    activateSkill,
  };
}

export type NewSessionDraftState = ReturnType<typeof useNewSessionDraft>;

/**
 * The workspace select + free-text cwd pair, shared by the /new hero chip's
 * popover.
 */
export function WorkspacePickerFields({ state }: { state: NewSessionDraftState }) {
  const { t } = useI18n();
  const [cwdBlurred, setCwdBlurred] = useState(false);
  const trimmedCwd = state.cwd.trim();
  const cwdInvalid = trimmedCwd !== '' && (state.sshLabel === null ? !isAbsoluteCwdPath(trimmedCwd) : !isAbsoluteRemoteCwdPath(trimmedCwd));
  const workspaceOptions: readonly SearchableSelectOption[] = useMemo(
    () => [
      {
        value: AUTO_WORKSPACE_ID,
        label: t('new.autoWorkspace'),
        description: t('new.autoWorkspaceHint'),
      },
      ...sortWorkspacesByPinnedThenRecency(state.workspaces).map((workspace) => ({
        value: workspace.id,
        label: workspace.name,
        hint: workspace.root,
        title: workspace.name,
      })),
    ],
    [state.workspaces, t],
  );

  // First run has no registered folders, but automatic allocation remains available.
  const firstRun = !state.workspacesLoading && state.workspaces.length === 0;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] font-medium text-ink-soft">
        {state.sshLabel === null ? t('connect.localScope') : `${t('connect.remoteScope')} · ${state.sshLabel}`}
      </p>
      {state.sshLabel !== null ? <p className="text-[11px] text-ink-soft">{t('connect.sshRemotePathHint')}</p> : null}
      {firstRun ? (
        <p className="text-[11.5px] leading-relaxed text-ink-soft">{t('new.firstRunHint')}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-[11px] font-medium text-ink-soft">{t('new.workspace')}</label>
        <SearchableSelect
          id="new-workspace-select"
          options={workspaceOptions}
          value={state.workspaceId !== '' ? state.workspaceId : (state.effectiveWorkspace?.id ?? AUTO_WORKSPACE_ID)}
          onChange={(nextId) => { state.selectWorkspace(nextId); }}
          disabled={state.workspacesLoading}
          ariaLabel={t('new.workspace')}
          buttonClassName="flex w-64 max-w-full items-center gap-1.5 rounded-md border border-hairline bg-paper px-2 py-1 text-[12px] text-ink outline-none transition-colors hover:border-hairline-strong focus:border-selected-ink disabled:cursor-not-allowed disabled:bg-hairline/20 disabled:text-ink-faint"
        />
        <span className="text-[11px] text-ink-faint">{t('new.or')}</span>
        {state.canBrowseForWorkspace ? (
          <button
            type="button"
            data-new-browse
            onClick={() => { void state.browseForWorkspace(); }}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-hairline bg-paper px-2 py-1 text-[12px] text-ink transition-colors hover:border-hairline-strong hover:text-ink focus-visible:border-selected-ink"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0 text-ink-soft">
              <path
                d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6a1.5 1.5 0 0 1 1.2.6l1 1.33a1.5 1.5 0 0 0 1.2.6h3A1.5 1.5 0 0 1 14 7v4.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
            {t('new.browse')}
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <input
            type="text"
            value={state.cwd}
            onChange={(event) => { state.setCwd(event.target.value); }}
            onBlur={() => { setCwdBlurred(true); }}
            aria-label={t('new.cwdAria')}
            aria-invalid={cwdBlurred && cwdInvalid ? true : undefined}
            placeholder={state.sshLabel === null ? t('new.cwdPlaceholder') : '/home/dev/project'}
            className={`min-w-0 flex-1 rounded-md border bg-paper px-2 py-1 font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-faint focus:border-selected-ink ${
              cwdBlurred && cwdInvalid ? 'border-danger' : 'border-hairline'
            }`}
          />
          {cwdBlurred && cwdInvalid ? (
            <p role="alert" className="mt-1 text-[10.5px] text-danger">
              {t(state.sshLabel === null ? 'new.cwdInvalid' : 'connect.sshCwdInvalid')}
            </p>
          ) : null}
        </div>
      </div>
      {state.autoWorkspace ? (
        <p className="text-[11px] leading-relaxed text-ink-faint">{t('new.autoWorkspaceHint')}</p>
      ) : null}
    </div>
  );
}

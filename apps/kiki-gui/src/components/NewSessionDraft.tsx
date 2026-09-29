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
import { useQuery } from '@tanstack/react-query';
import type {
  AuthSummary,
  NamedAgentProfile,
  PermissionMode,
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
} from '@kiki/session-core/composer';
import { sortWorkspacesByPinnedThenRecency, sortWorkspacesByRecency } from '@kiki/session-core/sessions';
import {
  composerDefaultsForProfile,
  readSettings,
  resolveEffectiveModel,
  resolveModelSource,
  resolveSelectedEffort,
  resolveSessionModelOverride,
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
} from '@kiki/session-core/settings';
import { DEFAULT_AGENT_PROFILE } from './Composer';
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
import { useWorktreeAvailability } from '../lib/worktrees';
import { useConnection } from '../state/connection';

const DRAFT_KEY = 'new';
const remoteDraftStorageKey = (scopeId: string) => `kiki.draft.new.${scopeId}`;

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
}): SessionCreate {
  const agent_config = {
    profile: input.profile,
    model: input.model,
    thinking: input.thinking,
    permission_mode: input.permissionMode,
    plan_mode: input.planMode,
  };
  const isolation = input.worktree === true ? { isolation: { kind: 'worktree' as const } } : {};
  return input.cwd !== ''
    ? { metadata: { cwd: input.cwd }, agent_config, ...isolation, ephemeral: input.ephemeral }
    : { workspace_id: input.workspaceId, agent_config, ...isolation, ephemeral: input.ephemeral };
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
  prefillNavigationKey,
}: {
  initialWorkspaceId?: string;
  /** `?agent=` prefill — the profile the new session binds at creation. */
  initialProfile?: string;
  /** Router history-entry identity survives reload/back but changes on a new navigation. */
  prefillNavigationKey?: string;
} = {}) {
  const host = useHost();
  const { client, scopeId, sshLabel } = useConnection();
  const draftScopeId = sshLabel === null ? 'local' : scopeId;
  const draftKey = draftScopeId === 'local' ? DRAFT_KEY : `${DRAFT_KEY}:${draftScopeId}`;
  const navigate = useGuardedNavigate();
  const { t } = useI18n();
  const liveSettings = useSyncExternalStore(
    subscribeSettings,
    settingsSnapshot,
    settingsServerSnapshot,
  );
  const settings = useMemo(() => readSettings(), []);
  const initialRestoredDraft = useMemo(() => readScopedNewSessionDraft(draftScopeId), [draftScopeId]);
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
  // The selected effort is the wire value. When the model catalog supplies a
  // visible default, sending without touching the select still submits it.
  const [effortOverride, setEffortOverrideState] = useState<string | undefined>(
    initialRestoredDraft.effortOverride,
  );
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [profileCatalogTransitionPending, setProfileCatalogTransitionPending] = useState(false);
  const profileCatalogTransitionRef = useRef(false);
  const hasNewProfilePrefill = applyPrefill && initialProfile !== undefined;
  const modelOverrideFromProfile = useRef(hasNewProfilePrefill || (initialRestoredDraft.modelFromProfile ?? initialRestoredDraft.profile === undefined));
  const effortOverrideFromProfile = useRef(hasNewProfilePrefill || (initialRestoredDraft.effortFromProfile ?? initialRestoredDraft.profile === undefined));

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    staleTime: 30_000,
  });
  const workspaces = workspacesQuery.data?.items ?? [];
  const workspacesLoading = workspacesQuery.isLoading;

  const effectiveWorkspace: Workspace | undefined = useMemo(
    () =>
      workspaceId === '' ? sortWorkspacesByRecency(workspaces)[0]
        : workspaceId === AUTO_WORKSPACE_ID ? undefined
        : workspaces.find((w) => w.id === workspaceId),
    [workspaces, workspaceId],
  );
  const autoWorkspace = cwd.trim() === '' && effectiveWorkspace === undefined
    && (workspaceId === '' || workspaceId === AUTO_WORKSPACE_ID);
  const worktreeRoot = cwd.trim() !== ''
    ? (isAbsoluteCwdPath(cwd.trim()) ? cwd.trim() : undefined)
    : effectiveWorkspace?.root;
  const worktreeAvailability = useWorktreeAvailability(client, { root: worktreeRoot, remote: sshLabel !== null });
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
  const catalogItem = (modelsQuery.data?.items ?? []).find((item) => item.id === effectiveModel);
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
    modelOverrideFromProfile.current = false;
    setModelOverrideState(model);
    setSelectionRevision((value) => value + 1);
  }, []);
  const setEffortOverride = useCallback((thinking: string | undefined) => {
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
    writeScopedNewSessionDraft(draftScopeId, {
      workspaceId: workspaceId || effectiveWorkspace?.id,
      cwd,
      profile: agentProfile,
      modelOverride,
      effortOverride,
      modelFromProfile: modelOverrideFromProfile.current,
      effortFromProfile: effortOverrideFromProfile.current,
      prefillSource,
    });
  }, [draftScopeId, workspaceId, effectiveWorkspace?.id, cwd, agentProfile, modelOverride, effortOverride, selectionRevision, prefillSource]);

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
    || (effectiveModel !== undefined && catalogItem === undefined)
    || (effortOverride !== undefined && catalogItem !== undefined && !supportedEfforts?.includes(effortOverride));

  // Refs keep the send path stable across renders: the /new page publishes a
  // memoized composer element into the conversation shell, and a send that
  // changes identity on every keystroke would defeat the memo.
  const sendContextRef = useRef({
    busy: busy || selectionBlocked,
    agentProfileCatalogPending,
    cwd,
    effectiveWorkspace,
    modelOverride,
    effectiveEffort,
    agentProfile,
    permissionMode,
    planMode,
    goalObjective,
    worktree,
    ephemeral,
  });
  sendContextRef.current = {
    busy: busy || selectionBlocked,
    agentProfileCatalogPending,
    cwd,
    effectiveWorkspace,
    modelOverride,
    effectiveEffort,
    agentProfile,
    permissionMode,
    planMode,
    goalObjective,
    worktree,
    ephemeral,
  };

  const createThenNavigate = useCallback((handoff: {
    initialPrompt?: string;
    initialAttachments?: readonly ComposerAttachment[];
    initialSkill?: DraftSkillHandoff;
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
    });

    // Returned so the composer's send latch rides the create round trip: a
    // second trigger while this is in flight is ignored, and a failed create
    // releases the latch for retry.
    return client
      .createSession(body)
      .then((session) => {
        writeDraft(draftKey, '');
        clearScopedNewSessionDraft(draftScopeId);
        // react-router's navigate returns a promise in data routers; the
        // navigation is fire-and-forget here (the catch below covers createSession).
        // The hand-off motion rides along with it and never delays the send.
        runNewSessionHandoff({
          text: handoff.initialPrompt,
          navigate: () => navigate(`/s/${session.id}`, {
            state: {
              initialPrompt: handoff.initialPrompt,
              initialAttachments: handoff.initialAttachments,
              initialSkill: handoff.initialSkill,
              model: context.modelOverride,
              thinking: context.effectiveEffort,
              permissionMode: context.permissionMode,
              planMode: context.planMode,
              goalObjective: handoff.goalObjectiveOverride ?? context.goalObjective,
            },
            replace: false,
          }),
        });
      })
      .catch((error: unknown) => {
        setBusy(false);
        setError(error instanceof Error ? error.message : String(error));
      });
  }, [client, draftKey, draftScopeId, sshLabel, navigate, t]);

  const send = useCallback((
    text: string,
    composerAttachments: readonly ComposerAttachment[],
    options?: { readonly goalObjective?: string },
  ) => {
    if (buildPromptContent(text, composerAttachments) === null) return;
    if (options?.goalObjective !== undefined) setGoalObjective(options.goalObjective);
    return createThenNavigate({
      initialPrompt: text.trim(),
      initialAttachments: composerAttachments,
      goalObjectiveOverride: options?.goalObjective,
    });
  }, [createThenNavigate]);

  const activateSkill = useCallback((
    name: string,
    args: string,
    composerAttachments: readonly ComposerAttachment[],
  ) => {
    return createThenNavigate({
      initialSkill: { name, args, attachments: composerAttachments },
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

  return {
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
    <div className="flex flex-col gap-2.5">
      <p className="text-[11px] font-medium text-accent">
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
          buttonClassName="flex w-64 max-w-full items-center gap-1.5 rounded-md border border-hairline bg-paper px-2 py-1 text-[12px] text-ink outline-none transition-colors hover:border-hairline-strong focus:border-accent disabled:cursor-not-allowed disabled:bg-hairline/20 disabled:text-ink-faint"
        />
        <span className="text-[11px] text-ink-faint">{t('new.or')}</span>
        {state.canBrowseForWorkspace ? (
          <button
            type="button"
            data-new-browse
            onClick={() => { void state.browseForWorkspace(); }}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-hairline bg-paper px-2 py-1 text-[12px] text-ink transition-colors hover:border-hairline-strong hover:text-accent focus-visible:border-accent"
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
            className={`min-w-0 flex-1 rounded-md border bg-paper px-2 py-1 font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-faint focus:border-accent ${
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

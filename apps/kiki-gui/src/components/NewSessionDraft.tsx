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
import type { AuthSummary, PermissionMode, SessionCreate, Workspace } from '@moonshot-ai/protocol';

import {
  buildPromptContent,
  readDraft,
  writeDraft,
  type ComposerAttachment,
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
import { useGuardedNavigate } from './dirtyGuard';
import { SearchableSelect, type SearchableSelectOption } from './SearchableSelect';
import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';

const DRAFT_KEY = 'new';

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
  readonly swarmMode: boolean;
}): SessionCreate {
  const agent_config = {
    profile: input.profile,
    model: input.model,
    thinking: input.thinking,
    permission_mode: input.permissionMode,
    plan_mode: input.planMode,
    swarm_mode: input.swarmMode,
  };
  return input.cwd !== ''
    ? { metadata: { cwd: input.cwd }, agent_config }
    : { workspace_id: input.workspaceId, agent_config };
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
}: {
  initialWorkspaceId?: string;
  /** `?agent=` prefill — the profile the new session binds at creation. */
  initialProfile?: string;
} = {}) {
  const host = useHost();
  const { client } = useConnection();
  const navigate = useGuardedNavigate();
  const { t } = useI18n();
  const liveSettings = useSyncExternalStore(
    subscribeSettings,
    settingsSnapshot,
    settingsServerSnapshot,
  );
  const settings = useMemo(() => readSettings(), []);

  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId ?? '');
  const [cwd, setCwd] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(settings.defaultPermissionMode);
  const [planMode, setPlanMode] = useState(settings.defaultPlanMode);
  const [swarmMode, setSwarmMode] = useState(false);
  const [goalObjective, setGoalObjective] = useState('');
  const [modelOverride, setModelOverride] = useState(() =>
    resolveSessionModelOverride(undefined),
  );
  const [agentProfile, setAgentProfileState] = useState(initialProfile ?? DEFAULT_AGENT_PROFILE);
  // The selected effort is the wire value. When the model catalog supplies a
  // visible default, sending without touching the select still submits it.
  const [effortOverride, setEffortOverride] = useState<string | undefined>(undefined);

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    staleTime: 30_000,
  });
  const workspaces = workspacesQuery.data?.items ?? [];
  const workspacesLoading = workspacesQuery.isLoading;

  const effectiveWorkspace: Workspace | undefined = useMemo(
    () =>
      workspaces.find((w) => w.id === workspaceId) ??
      sortWorkspacesByRecency(workspaces)[0],
    [workspaces, workspaceId],
  );

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });
  const serverDefaultModel = configQuery.data?.default_model;

  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: () => client.listModels(),
    staleTime: 60_000,
  });
  const agentProfilesQuery = useQuery({
    queryKey: ['agentProfiles'],
    queryFn: () => client.listNamedAgentProfiles(),
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
  const catalogItem = (modelsQuery.data?.items ?? []).find((item) => item.model === effectiveModel);
  const supportedEfforts = catalogItem?.support_efforts;
  const effectiveEffort = resolveSelectedEffort(
    supportedEfforts,
    effortOverride,
    catalogItem?.default_effort,
  );

  useEffect(() => {
    setDraft(readDraft(DRAFT_KEY));
  }, []);

  const appliedInitialProfileDefaults = useRef(false);
  useEffect(() => {
    if (appliedInitialProfileDefaults.current) return;
    if (initialProfile === undefined) return;
    const items = agentProfilesQuery.data?.items;
    if (items === undefined) return;
    appliedInitialProfileDefaults.current = true;
    const defaults = composerDefaultsForProfile(items, initialProfile);
    setModelOverride(defaults.model);
    setEffortOverride(defaults.thinking);
  }, [agentProfilesQuery.data, initialProfile]);

  const updateDraft = useCallback((text: string) => {
    setDraft(text);
    writeDraft(DRAFT_KEY, text);
  }, []);

  // Refs keep the send path stable across renders: the /new page publishes a
  // memoized composer element into the conversation shell, and a send that
  // changes identity on every keystroke would defeat the memo.
  const sendContextRef = useRef({
    busy,
    cwd,
    effectiveWorkspace,
    modelOverride,
    effectiveEffort,
    agentProfile,
    permissionMode,
    planMode,
    swarmMode,
    goalObjective,
  });
  sendContextRef.current = {
    busy,
    cwd,
    effectiveWorkspace,
    modelOverride,
    effectiveEffort,
    agentProfile,
    permissionMode,
    planMode,
    swarmMode,
    goalObjective,
  };

  const createThenNavigate = useCallback((handoff: {
    initialPrompt?: string;
    initialAttachments?: readonly ComposerAttachment[];
    initialSkill?: DraftSkillHandoff;
  }) => {
    const context = sendContextRef.current;
    if (context.busy) return;
    const trimmedCwd = context.cwd.trim();
    // A free-text cwd must be an absolute path — a relative one would be
    // resolved against the server's own cwd and silently land elsewhere.
    if (trimmedCwd !== '' && !isAbsoluteCwdPath(trimmedCwd)) {
      setError(t('new.cwdInvalid'));
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
      swarmMode: context.swarmMode,
    });

    client
      .createSession(body)
      .then((session) => {
        writeDraft(DRAFT_KEY, '');
        // react-router's navigate returns a promise in data routers; the
        // navigation is fire-and-forget here (the catch below covers createSession).
        void navigate(`/s/${session.id}`, {
          state: {
            initialPrompt: handoff.initialPrompt,
            initialAttachments: handoff.initialAttachments,
            initialSkill: handoff.initialSkill,
            model: context.modelOverride,
            thinking: context.effectiveEffort,
            permissionMode: context.permissionMode,
            planMode: context.planMode,
            swarmMode: context.swarmMode,
            goalObjective: context.goalObjective,
          },
          replace: false,
        });
      })
      .catch((error: unknown) => {
        setBusy(false);
        setError(error instanceof Error ? error.message : String(error));
      });
  }, [client, navigate, t]);

  const send = useCallback((text: string, composerAttachments: readonly ComposerAttachment[]) => {
    if (buildPromptContent(text, composerAttachments) === null) return;
    createThenNavigate({
      initialPrompt: text.trim(),
      initialAttachments: composerAttachments,
    });
  }, [createThenNavigate]);

  const activateSkill = useCallback((
    name: string,
    args: string,
    composerAttachments: readonly ComposerAttachment[],
  ) => {
    createThenNavigate({
      initialSkill: { name, args, attachments: composerAttachments },
    });
  }, [createThenNavigate]);

  const selectWorkspace = useCallback((nextId: string) => {
    setWorkspaceId(nextId);
    if (nextId !== '') setCwd('');
  }, []);

  /**
   * Native folder picker (desktop only). A picked folder lands in the cwd
   * field rather than creating a workspace up front: the session's own
   * creation registers it, so cancelling out of /new leaves no debris.
   */
  const browseForWorkspace = useCallback(async () => {
    try {
      const picked = await host.pickDirectory?.();
      if (picked === undefined || picked === null) return;
      setWorkspaceId('');
      setCwd(picked);
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [host]);

  const setAgentProfile = useCallback((name: string) => {
    const defaults = composerDefaultsForProfile(agentProfilesQuery.data?.items ?? [], name);
    setAgentProfileState(name);
    setModelOverride(defaults.model);
    setEffortOverride(defaults.thinking);
  }, [agentProfilesQuery.data]);

  return {
    draft,
    attachments,
    busy,
    error,
    workspaceId,
    cwd,
    permissionMode,
    planMode,
    swarmMode,
    goalObjective,
    modelOverride,
    agentProfile,
    workspaces,
    workspacesLoading,
    effectiveWorkspace,
    needsProviderSetup: providerSetupNeeded,
    canBrowseForWorkspace: host.pickDirectory !== undefined,
    browseForWorkspace,
    serverDefaultModel,
    inheritedDefault,
    modelSource,
    supportedEfforts,
    effectiveEffort,
    updateDraft,
    setAttachments,
    selectWorkspace,
    setCwd,
    setPermissionMode,
    setPlanMode,
    setSwarmMode,
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
  const cwdInvalid = trimmedCwd !== '' && !isAbsoluteCwdPath(trimmedCwd);
  const workspaceOptions: readonly SearchableSelectOption[] = useMemo(
    () =>
      sortWorkspacesByPinnedThenRecency(state.workspaces).map((workspace) => ({
        value: workspace.id,
        label: workspace.name,
        hint: workspace.root,
        title: workspace.name,
      })),
    [state.workspaces],
  );

  // First run has nothing in the dropdown, so the row alone reads as broken.
  // One sentence above it says what a workspace is for.
  const firstRun = !state.workspacesLoading && state.workspaces.length === 0;

  return (
    <div className="flex flex-col gap-2.5">
      {firstRun ? (
        <p className="text-[11.5px] leading-relaxed text-ink-soft">{t('new.firstRunHint')}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-[11px] font-medium text-ink-soft">{t('new.workspace')}</label>
        <SearchableSelect
          id="new-workspace-select"
          options={workspaceOptions}
          value={state.workspaceId !== '' ? state.workspaceId : (state.effectiveWorkspace?.id ?? '')}
          onChange={(nextId) => { state.selectWorkspace(nextId); }}
          disabled={state.workspacesLoading}
          emptyText={t('new.noWorkspaces')}
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
            placeholder={t('new.cwdPlaceholder')}
            className={`min-w-0 flex-1 rounded-md border bg-paper px-2 py-1 font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-faint focus:border-accent ${
              cwdBlurred && cwdInvalid ? 'border-danger' : 'border-hairline'
            }`}
          />
          {cwdBlurred && cwdInvalid ? (
            <p role="alert" className="mt-1 text-[10.5px] text-danger">
              {t('new.cwdInvalid')}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

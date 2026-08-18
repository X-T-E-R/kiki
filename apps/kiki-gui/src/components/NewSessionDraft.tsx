/**
 * NewSessionDraft — the workspace/cwd picker state behind the /new full-page
 * draft, the only new-session surface. The hook owns draft persistence
 * (`lib/drafts.ts` key "new"), model/permission state, and the
 * create-then-navigate send path.
 *
 * The /new page does not render the Composer here: it registers this state
 * into the conversation shell's composer seat (see NewSessionPage), so the
 * textarea survives the hero → session transition.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PermissionMode, Workspace } from '@moonshot-ai/protocol';

import { resolveSelectedEffort } from './Composer';
import { useGuardedNavigate } from './dirtyGuard';
import { SearchableSelect, type SearchableSelectOption } from './SearchableSelect';
import { useI18n } from '../i18n';
import { buildPromptContent, type ComposerAttachment } from '../lib/attachments';
import { readDraft, writeDraft } from '../lib/drafts';
import { sortWorkspacesByRecency } from '../lib/sorting';
import {
  readSettings,
  resolveEffectiveModel,
  resolveModelSource,
  resolveSessionModelOverride,
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
} from '../lib/settings';
import { useConnection } from '../state/connection';

const DRAFT_KEY = 'new';

/**
 * Basic absolute-path check for the free-text cwd field, across platforms:
 * POSIX `/…`, Windows drive `C:\…` / `C:/…`, or UNC `\\server\…`. Relative
 * paths are rejected — the server would resolve them against its own cwd,
 * which is never what the user meant.
 */
export function isAbsoluteCwdPath(value: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(value);
}

export function useNewSessionDraft({
  initialWorkspaceId,
}: {
  initialWorkspaceId?: string;
} = {}) {
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
    permissionMode,
    planMode,
    swarmMode,
    goalObjective,
  };

  const send = useCallback((text: string, composerAttachments: readonly ComposerAttachment[]) => {
    const context = sendContextRef.current;
    if (context.busy) return;
    if (buildPromptContent(text, composerAttachments) === null) return;
    const trimmedCwd = context.cwd.trim();
    // A free-text cwd must be an absolute path — a relative one would be
    // resolved against the server's own cwd and silently land elsewhere.
    if (trimmedCwd !== '' && !isAbsoluteCwdPath(trimmedCwd)) {
      setError(t('new.cwdInvalid'));
      return;
    }
    setBusy(true);
    setError(null);

    const body =
      trimmedCwd !== ''
        ? { metadata: { cwd: trimmedCwd } }
        : { workspace_id: context.effectiveWorkspace?.id };

    client
      .createSession(body)
      .then((session) => {
        writeDraft(DRAFT_KEY, '');
        // react-router's navigate returns a promise in data routers; the
        // navigation is fire-and-forget here (the catch below covers createSession).
        void navigate(`/s/${session.id}`, {
          state: {
            initialPrompt: text.trim(),
            initialAttachments: composerAttachments,
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

  const selectWorkspace = useCallback((nextId: string) => {
    setWorkspaceId(nextId);
    if (nextId !== '') setCwd('');
  }, []);

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
    workspaces,
    workspacesLoading,
    effectiveWorkspace,
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
    setEffortOverride,
    send,
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
      sortWorkspacesByRecency(state.workspaces).map((workspace) => ({
        value: workspace.id,
        label: workspace.name,
        hint: workspace.root,
        title: workspace.name,
      })),
    [state.workspaces],
  );

  return (
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
  );
}

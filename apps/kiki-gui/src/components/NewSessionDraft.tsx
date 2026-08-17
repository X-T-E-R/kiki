/**
 * NewSessionDraft — the shared workspace/cwd picker plus Composer used by both
 * the /new full-page draft and the Ctrl+N NewSessionDialog modal. The hook
 * owns draft persistence (`lib/drafts.ts` key "new"), model/permission state,
 * and the create-then-navigate send path, so opening either surface resumes
 * the same draft and sending behaves identically.
 *
 * The /new page no longer renders the Composer here: it registers this
 * state into the conversation shell's composer seat (see NewSessionPage), so
 * the textarea survives the hero → session transition. The dialog keeps
 * rendering `NewSessionDraftPanel` itself (modal lifetime, remount is fine).
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PermissionMode, Workspace } from '@moonshot-ai/protocol';

import { Composer, resolveSelectedEffort } from './Composer';
import { useGuardedNavigate } from './dirtyGuard';
import { useI18n } from '../i18n';
import { buildPromptContent, type ComposerAttachment } from '../lib/attachments';
import { readDraft, writeDraft } from '../lib/drafts';
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
  onSent,
}: {
  initialWorkspaceId?: string;
  /** Called once the server created the session and navigation was kicked off. */
  onSent?: () => void;
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
      workspaces.toSorted((a, b) => b.last_opened_at.localeCompare(a.last_opened_at))[0],
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
    onSent,
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
    onSent,
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
        context.onSent?.();
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
 * The workspace select + free-text cwd pair, shared verbatim between the
 * dialog's panel layout and the /new hero chip's popover.
 */
export function WorkspacePickerFields({ state }: { state: NewSessionDraftState }) {
  const { t } = useI18n();
  const [cwdBlurred, setCwdBlurred] = useState(false);
  const trimmedCwd = state.cwd.trim();
  const cwdInvalid = trimmedCwd !== '' && !isAbsoluteCwdPath(trimmedCwd);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="text-[11px] font-medium text-ink-soft">{t('new.workspace')}</label>
      <select
        className="max-w-xs truncate rounded-md border border-hairline bg-paper px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
        value={state.workspaceId !== '' ? state.workspaceId : (state.effectiveWorkspace?.id ?? '')}
        onChange={(event) => { state.selectWorkspace(event.target.value); }}
        disabled={state.workspacesLoading}
      >
        {state.workspaces.length === 0 ? <option value="">{t('new.noWorkspaces')}</option> : null}
        {state.workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}
          </option>
        ))}
      </select>
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

/**
 * The workspace/cwd row plus Composer plus the inline error — the modal form.
 * `autoFocus` focuses the Composer textarea on mount — used by the dialog so
 * Ctrl+N lands ready to type; the page keeps its historical unfocused first
 * paint.
 */
export function NewSessionDraftPanel({
  state,
  autoFocus = false,
}: {
  state: NewSessionDraftState;
  autoFocus?: boolean;
}) {
  const { client } = useConnection();
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const composerDisabled = state.busy || state.workspacesLoading || state.effectiveWorkspace === undefined;

  // The dialog's initial `[data-autofocus]` focus lands while the Composer is
  // still disabled (workspaces query in flight), which silently fails. Once
  // the query resolves and the textarea enables, re-focus it here — unless the
  // user already moved focus to another control inside the panel.
  useEffect(() => {
    if (!autoFocus || composerDisabled) return;
    const root = rootRef.current;
    if (root === null || root.contains(document.activeElement)) return;
    root.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [autoFocus, composerDisabled]);

  return (
    <div ref={rootRef}>
      <div className="mb-6 space-y-3 rounded-2xl border border-hairline bg-panel p-4 shadow-[0_2px_4px_rgba(28,25,23,0.03),0_16px_40px_-20px_rgba(28,25,23,0.18)]">
        <WorkspacePickerFields state={state} />
      </div>

      <Composer
        busy={state.busy}
        disabled={composerDisabled}
        value={state.draft}
        onChange={state.updateDraft}
        model={state.modelOverride}
        defaultModel={undefined}
        serverDefaultModel={state.inheritedDefault}
        modelSource={state.modelSource}
        permissionMode={state.permissionMode}
        planMode={state.planMode}
        swarmMode={state.swarmMode}
        goalObjective={state.goalObjective}
        goalStatus={undefined}
        goalControl={undefined}
        efforts={state.supportedEfforts}
        effort={state.effectiveEffort}
        busyPlaceholder={t('new.creating')}
        autoFocus={autoFocus}
        fsSearch={
          // The session-less `@` picker searches the workspace directly
          // (kap-server `POST /workspace/fs:search`); a custom cwd rides
          // the same `workspace` slot as an absolute root.
          state.cwd.trim() !== '' || state.effectiveWorkspace !== undefined
            ? (query) =>
                client
                  .workspaceFsSearch(
                    state.cwd.trim() !== '' ? state.cwd.trim() : state.effectiveWorkspace!.id,
                    { query, limit: 30 },
                  )
                  .then((result) => result.items)
            : undefined
        }
        attachments={state.attachments}
        onChangeAttachments={state.setAttachments}
        mentionScopeKey={state.cwd.trim() !== '' ? `cwd:${state.cwd.trim()}` : `ws:${state.effectiveWorkspace?.id ?? ''}`}
        onChangeModel={state.setModelOverride}
        onChangePermissionMode={state.setPermissionMode}
        onChangePlanMode={state.setPlanMode}
        onChangeSwarmMode={state.setSwarmMode}
        onChangeGoalObjective={state.setGoalObjective}
        onChangeGoalControl={() => {}}
        onChangeEffort={state.setEffortOverride}
        onSend={state.send}
      />

      {state.error !== null ? (
        <div className="mt-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 font-mono text-[11.5px] text-danger">
          {state.error}
        </div>
      ) : null}
    </div>
  );
}

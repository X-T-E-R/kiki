/**
 * NewSessionDraft — the shared workspace/cwd picker plus Composer used by both
 * the /new full-page draft and the Ctrl+N NewSessionDialog modal. The hook
 * owns draft persistence (`lib/drafts.ts` key "new"), model/permission state,
 * and the create-then-navigate send path, so opening either surface resumes
 * the same draft and sending behaves identically.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import type { PermissionMode, Workspace } from '@moonshot-ai/protocol';

import { Composer } from './Composer';
import { useI18n } from '../i18n';
import { buildPromptContent, type ComposerAttachment } from '../lib/attachments';
import { readDraft, writeDraft } from '../lib/drafts';
import { readSettings } from '../lib/settings';
import { useConnection } from '../state/connection';

const DRAFT_KEY = 'new';

export function useNewSessionDraft({
  initialWorkspaceId,
  onSent,
}: {
  initialWorkspaceId?: string;
  /** Called once the server created the session and navigation was kicked off. */
  onSent?: () => void;
} = {}) {
  const { client } = useConnection();
  const navigate = useNavigate();
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
  const [modelOverride, setModelOverride] = useState(settings.defaultModel);
  const [effortOverride, setEffortOverride] = useState(settings.defaultEffort);

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    staleTime: 30_000,
  });
  const workspaces = workspacesQuery.data?.items ?? [];

  const effectiveWorkspace: Workspace | undefined =
    workspaces.find((w) => w.id === workspaceId) ??
    workspaces.toSorted((a, b) => b.last_opened_at.localeCompare(a.last_opened_at))[0];

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
  const effectiveModel = modelOverride ?? serverDefaultModel;
  const catalogItem = (modelsQuery.data?.items ?? []).find((item) => item.model === effectiveModel);
  const supportedEfforts = catalogItem?.support_efforts;
  const effectiveEffort =
    supportedEfforts !== undefined && supportedEfforts.length > 0
      ? (effortOverride ?? catalogItem?.default_effort ?? supportedEfforts[0])
      : undefined;

  useEffect(() => {
    setDraft(readDraft(DRAFT_KEY));
  }, []);

  const updateDraft = (text: string) => {
    setDraft(text);
    writeDraft(DRAFT_KEY, text);
  };

  const send = (text: string, composerAttachments: readonly ComposerAttachment[]) => {
    if (busy) return;
    if (buildPromptContent(text, composerAttachments) === null) return;
    setBusy(true);
    setError(null);

    const trimmedCwd = cwd.trim();
    const body =
      trimmedCwd !== ''
        ? { metadata: { cwd: trimmedCwd } }
        : { workspace_id: effectiveWorkspace?.id };

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
            model: effectiveModel,
            thinking: effectiveEffort,
            permissionMode,
            planMode,
            swarmMode,
            goalObjective,
          },
          replace: false,
        });
        onSent?.();
      })
      .catch((error: unknown) => {
        setBusy(false);
        setError(error instanceof Error ? error.message : String(error));
      });
  };

  const selectWorkspace = (nextId: string) => {
    setWorkspaceId(nextId);
    if (nextId !== '') setCwd('');
  };

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
    workspacesLoading: workspacesQuery.isLoading,
    effectiveWorkspace,
    serverDefaultModel,
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
 * The workspace/cwd row plus Composer plus the inline error. `autoFocus`
 * focuses the Composer textarea on mount — used by the dialog so Ctrl+N lands
 * ready to type; the page keeps its historical unfocused first paint.
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
          <input
            type="text"
            value={state.cwd}
            onChange={(event) => { state.setCwd(event.target.value); }}
            placeholder="C:/path/to/project"
            className="min-w-0 flex-1 rounded-md border border-hairline bg-paper px-2 py-1 font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
          />
        </div>
      </div>

      <Composer
        busy={state.busy}
        disabled={composerDisabled}
        value={state.draft}
        onChange={state.updateDraft}
        model={state.modelOverride}
        defaultModel={undefined}
        serverDefaultModel={state.serverDefaultModel}
        modelSource={state.modelOverride !== undefined ? 'override' : 'server-default'}
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

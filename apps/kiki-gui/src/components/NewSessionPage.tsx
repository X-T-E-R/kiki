/**
 * NewSessionPage — /new is a full-page draft conversation, not a dialog.
 *
 * The user picks workspace/cwd, model, permission mode, and plan mode inline,
 * then types and sends. The first send creates the server session and navigates
 * to /s/:id with the prompt in location state so the live view subscribes before
 * the prompt is submitted.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';

import type { PermissionMode, Workspace } from '@moonshot-ai/protocol';

import { Composer } from './Composer';
import { Wordmark } from './Wordmark';
import { readDraft, writeDraft } from '../lib/drafts';
import { readSettings } from '../lib/settings';
import { useConnection } from '../state/connection';

const DRAFT_KEY = 'new';

export function NewSessionPage({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { client } = useConnection();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const workspaceParam = searchParams.get('workspace') ?? undefined;
  const settings = useMemo(() => readSettings(), []);

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [workspaceId, setWorkspaceId] = useState<string>(workspaceParam ?? '');
  const [cwd, setCwd] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(settings.defaultPermissionMode);
  const [planMode, setPlanMode] = useState(settings.defaultPlanMode);
  const [modelOverride, setModelOverride] = useState<string | undefined>(settings.defaultModel);
  const [effortOverride, setEffortOverride] = useState<string | undefined>(settings.defaultEffort);

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    staleTime: 30_000,
  });
  const workspaces = workspacesQuery.data?.items ?? [];

  const recentQuery = useQuery({
    queryKey: ['sessions', 'recent'],
    queryFn: () => client.listSessions({ page_size: 5 }),
    staleTime: 5000,
  });
  const recentSessions = recentQuery.data?.items ?? [];

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

  const send = (text: string) => {
    if (busy || text.trim() === '') return;
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
        navigate(`/s/${session.id}`, {
          state: {
            initialPrompt: text.trim(),
            model: effectiveModel,
            thinking: effectiveEffort,
            permissionMode,
            planMode,
          },
          replace: false,
        });
      })
      .catch((error: unknown) => {
        setBusy(false);
        setError(error instanceof Error ? error.message : String(error));
      });
  };

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-panel px-4">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label="Open session menu"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-hairline text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink md:hidden"
        >
          <span aria-hidden>☰</span>
        </button>
        <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-tight text-ink">
          New session
        </h1>
      </header>

      <main className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-10">
        <div className="w-full max-w-[760px]">
          <div className="mb-8 text-center">
            <Wordmark size="lg" />
            <p className="mt-3 text-[13px] text-ink-soft">
              Pick where kiki works, then ask anything.
            </p>
          </div>

          <div className="mb-6 space-y-3 rounded-2xl border border-hairline bg-panel p-4 shadow-[0_2px_4px_rgba(28,25,23,0.03),0_16px_40px_-20px_rgba(28,25,23,0.18)]">
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-[11px] font-medium text-ink-soft">Workspace</label>
              <select
                className="max-w-xs truncate rounded-md border border-hairline bg-paper px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
                value={workspaceId !== '' ? workspaceId : (effectiveWorkspace?.id ?? '')}
                onChange={(event) => {
                  setWorkspaceId(event.target.value);
                  if (event.target.value !== '') setCwd('');
                }}
                disabled={workspacesQuery.isLoading}
              >
                {workspaces.length === 0 ? <option value="">(no workspaces)</option> : null}
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-ink-faint">or</span>
              <input
                type="text"
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                placeholder="C:/path/to/project"
                className="min-w-0 flex-1 rounded-md border border-hairline bg-paper px-2 py-1 font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
              />
            </div>
          </div>

          {recentSessions.length > 0 ? (
            <div className="mb-6">
              <p className="mb-2 text-[11px] font-medium text-ink-soft">Recent sessions</p>
              <div className="flex flex-wrap gap-2">
                {recentSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => navigate(`/s/${session.id}`)}
                    className="max-w-[200px] truncate rounded-full border border-hairline bg-panel px-3 py-1 text-[11.5px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
                  >
                    {session.title !== '' ? session.title : session.last_prompt ?? session.id}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <Composer
            busy={busy}
            disabled={busy || workspacesQuery.isLoading || effectiveWorkspace === undefined}
            value={draft}
            onChange={updateDraft}
            model={modelOverride}
            defaultModel={undefined}
            serverDefaultModel={serverDefaultModel}
            modelSource={modelOverride !== undefined ? 'override' : 'server-default'}
            permissionMode={permissionMode}
            planMode={planMode}
            efforts={supportedEfforts}
            effort={effectiveEffort}
            onChangeModel={setModelOverride}
            onChangePermissionMode={setPermissionMode}
            onChangePlanMode={setPlanMode}
            onChangeEffort={setEffortOverride}
            onSend={send}
            onAbort={() => {}}
          />

          {error !== null ? (
            <div className="mt-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 font-mono text-[11.5px] text-danger">
              {error}
            </div>
          ) : null}
        </div>
      </main>
    </>
  );
}

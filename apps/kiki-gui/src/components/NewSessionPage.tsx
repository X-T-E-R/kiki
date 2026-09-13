/**
 * NewSessionPage — the /new hero: wordmark headline + tagline, the workspace
 * chip row, and recent-sessions chips. The composer itself is NOT rendered
 * here — this route publishes it into the conversation shell's seat (same DOM
 * node that docks at the bottom once the first send lands on /s/:id).
 *
 * The workspace picker + send path come from the shared `useNewSessionDraft`
 * hook; /new is the single new-session surface (Ctrl+N and the sidebar button
 * navigate here).
 */

import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { Composer } from './Composer';
import { AgentCapabilitiesPanel } from './AgentCapabilitiesPanel';
import { ContextBreakdownProvider } from './ContextMeter';
import { useConversationShell, useRegisterSeat, type ConversationSeat } from './ConversationShell';
import { isAbsoluteCwdPath, WorkspacePickerFields, useNewSessionDraft, type NewSessionDraftState } from './NewSessionDraft';
import { Wordmark } from './Wordmark';
import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';

/** Basename label for the workspace chip; separator-only paths echo raw. */
function workspaceChipLabel(state: NewSessionDraftState): string | undefined {
  const cwd = state.cwd.trim();
  if (cwd !== '') {
    const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
    return base !== '' ? base : cwd;
  }
  return state.effectiveWorkspace?.name;
}

/**
 * The hero workspace chip (folder + label + chevron), transparent at rest and
 * filled on hover/open. Opens a popover carrying the same workspace/cwd
 * fields — the workspace stays switchable until the first message creates the
 * session.
 */
function HeroWorkspaceChip({ state }: { state: NewSessionDraftState }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const label = workspaceChipLabel(state);

  return (
    <div className="relative" data-hero-workspace>
      <button
        type="button"
        onClick={() => { setOpen((value) => !value); }}
        aria-label={t('hero.workspaceAria')}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="hero-workspace-chip flex max-w-[min(100%,360px)] items-center gap-1.5 rounded-full border border-transparent px-2.5 py-1 text-[12.5px] font-medium text-ink transition-colors"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0 text-ink-soft">
          <path
            d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6a1.5 1.5 0 0 1 1.2.6l1 1.33a1.5 1.5 0 0 0 1.2.6h3A1.5 1.5 0 0 1 14 7v4.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
        <span className="min-w-0 truncate">
          {label ?? (state.workspacesLoading ? t('hero.workspaceLoading') : t('hero.chooseWorkspace'))}
        </span>
        <svg
          width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden
          className={`shrink-0 text-ink-faint transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="anim-enter absolute bottom-8 left-1/2 z-30 w-[26rem] max-w-[calc(100vw-48px)] -translate-x-1/2 rounded-xl border border-hairline bg-panel p-3 text-left shadow-[0_12px_32px_-12px_rgba(28,25,23,0.35)]">
          <WorkspacePickerFields state={state} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * First-run readiness card: shown only when the server reports no provider
 * and no model, i.e. the next send is guaranteed to fail. Both actions deep
 * link into the providers section so the fix happens where it lives.
 */
function ProviderSetupCard() {
  const { t } = useI18n();
  const navigate = useNavigate();

  return (
    <div
      data-provider-setup
      className="mx-auto mt-5 w-full max-w-[var(--kiki-chat-content-width,760px)] rounded-xl border border-accent/30 bg-accent-soft/40 px-4 py-3 text-left"
    >
      <p className="font-display text-[13.5px] font-semibold tracking-tight text-ink">
        {t('new.setupTitle')}
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{t('new.setupBody')}</p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => { void navigate('/settings/ai?tab=providers#st-card-auth'); }}
          className="rounded-md border border-accent bg-accent px-2.5 py-1 text-[12px] font-medium text-paper transition-opacity hover:opacity-90"
        >
          {t('new.setupSignIn')}
        </button>
        <button
          type="button"
          onClick={() => { void navigate('/settings/ai?tab=providers#st-card-providers-add'); }}
          className="rounded-md border border-hairline-strong bg-panel px-2.5 py-1 text-[12px] text-ink transition-colors hover:border-accent hover:text-accent"
        >
          {t('new.setupApiKey')}
        </button>
      </div>
    </div>
  );
}

export function NewSessionPage({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const location = useLocation();
  return <NewSessionPageContent key={`${location.key}:${location.search}`} onToggleSidebar={onToggleSidebar} prefillNavigationKey={location.key} />;
}

function NewSessionPageContent({ onToggleSidebar, prefillNavigationKey }: {
  onToggleSidebar: () => void;
  prefillNavigationKey: string;
}) {
  const { client } = useConnection();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const workspaceParam = searchParams.get('workspace') ?? undefined;
  const agentParam = searchParams.get('agent') ?? undefined;
  const { slots } = useConversationShell();

  const state = useNewSessionDraft({ initialWorkspaceId: workspaceParam, initialProfile: agentParam, prefillNavigationKey });

  const recentQuery = useQuery({
    queryKey: ['sessions', 'recent'],
    queryFn: () => client.listSessions({ page_size: 5 }),
    staleTime: 5000,
  });
  const recentSessions = useMemo(() => recentQuery.data?.items ?? [], [recentQuery.data]);

  // Only creation locks input. Catalog validation and missing targets block
  // sending while keeping the draft and selection controls editable.
  const composerDisabled = state.busy;
  const cwd = state.cwd.trim();
  const sendDisabled =
    state.effectiveWorkspace === undefined && (cwd === '' || !isAbsoluteCwdPath(cwd));
  const showTargetHint = sendDisabled && !state.workspacesLoading;
  const mentionScopeKey = cwd !== '' ? `cwd:${cwd}` : `ws:${state.effectiveWorkspace?.id ?? ''}`;

  const fsSearch = useMemo(
    () =>
      // The session-less `@` picker searches the workspace directly
      // (kap-server `POST /workspace/fs:search`); a custom cwd rides
      // the same `workspace` slot as an absolute root.
      cwd !== '' || state.effectiveWorkspace !== undefined
        ? (query: string) =>
            client
              .workspaceFsSearch(cwd !== '' ? cwd : state.effectiveWorkspace!.id, {
                query,
                limit: 30,
              })
              .then((result) => result.items)
        : undefined,
    [client, cwd, state.effectiveWorkspace],
  );

  // The seat is the hero's composer card plus the phase flag. MEMOIZED: the
  // shell re-publishes on identity change, so a fresh object per render would
  // loop. Every reactive value the element reads is a dep.
  const seat: ConversationSeat = useMemo(
    () => ({
      phase: 'hero',
      composer: (
        // Keep the seat's top-level element type identical to the session
        // view's (ContextBreakdownProvider > Composer): a type change here
        // remounts the subtree and destroys the textarea DOM node across the
        // /new → /s/:id flip, which the hero-shell proof forbids.
        <ContextBreakdownProvider value={undefined}>
          <Composer
          busy={state.busy}
          disabled={composerDisabled}
          sendDisabled={sendDisabled}
          sendDisabledTitle={showTargetHint ? t('new.noTargetHint') : undefined}
          value={state.draft}
          onChange={state.updateDraft}
          model={state.modelOverride}
          defaultModel={undefined}
          serverDefaultModel={state.inheritedDefault}
          modelSource={state.modelSource}
          agentProfile={state.agentProfile}
          onChangeAgentProfile={state.setAgentProfile}
          permissionMode={state.permissionMode}
          planMode={state.planMode}
          swarmMode={state.swarmMode}
          goalObjective={state.goalObjective}
          goalStatus={undefined}
          goalControl={undefined}
          efforts={state.supportedEfforts}
          effort={state.effectiveEffort}
          busyPlaceholder={t('new.creating')}
          workspaceId={cwd === '' ? state.effectiveWorkspace?.id : undefined}
          agentProfileCatalogMode={state.agentProfileCatalogMode}
          fsSearch={fsSearch}
          attachments={state.attachments}
          onChangeAttachments={state.setAttachments}
          mentionScopeKey={mentionScopeKey}
          onChangeModel={state.setModelOverride}
          onChangePermissionMode={state.setPermissionMode}
          onChangePlanMode={state.setPlanMode}
          onChangeSwarmMode={state.setSwarmMode}
          onChangeGoalObjective={state.setGoalObjective}
          onChangeGoalControl={() => {}}
          onChangeEffort={state.setEffortOverride}
          onSend={state.send}
          onActivateSkill={state.activateSkill}
          />
        </ContextBreakdownProvider>
      ),
    }),
    [
      state.busy,
      composerDisabled,
      sendDisabled,
      showTargetHint,
      state.draft,
      state.updateDraft,
      state.modelOverride,
      state.agentProfile,
      state.setAgentProfile,
      state.inheritedDefault,
      state.modelSource,
      state.permissionMode,
      state.planMode,
      state.swarmMode,
      state.goalObjective,
      state.supportedEfforts,
      state.effectiveEffort,
      cwd,
      state.effectiveWorkspace,
      state.agentProfileCatalogMode,
      fsSearch,
      state.attachments,
      state.setAttachments,
      mentionScopeKey,
      state.setModelOverride,
      state.setPermissionMode,
      state.setPlanMode,
      state.setSwarmMode,
      state.setGoalObjective,
      state.setEffortOverride,
      state.send,
      state.activateSkill,
      t,
    ],
  );
  useRegisterSeat(seat);

  return (
    <>
      {slots.header !== null
        ? createPortal(
            <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-panel px-4">
              <button
                type="button"
                onClick={onToggleSidebar}
                aria-label={t('sv.openMenuAria')}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-hairline text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink md:hidden"
              >
                <span aria-hidden>☰</span>
              </button>
              <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-tight text-ink">
                {t('new.title')}
              </h1>
            </header>,
            slots.header,
          )
        : null}

      {/* Hero chrome — centered with the shell-owned composer card as one
          stack (see .conversation-shell[data-phase='hero'] in index.css). */}
      <div className="flex w-full flex-col items-center px-6 pb-2 text-center">
        <span className="hero-wordmark inline-flex cursor-default">
          <Wordmark size="lg" />
        </span>
        <p className="mt-3 text-[13px] text-ink-soft">{t('new.tagline')}</p>
        <div className="mt-4 flex min-w-0 items-center justify-center self-stretch">
          <HeroWorkspaceChip state={state} />
        </div>
        {showTargetHint ? (
          <p className="mt-2 text-[11.5px] text-ink-faint">{t('new.noTargetHint')}</p>
        ) : null}
        {state.workspaceId !== '' && cwd === '' && !state.workspacesLoading && state.effectiveWorkspace === undefined ? (
          <p role="alert" className="mt-2 text-[11.5px] text-danger">{t('selection.workspaceInvalid', { value: state.workspaceId })}</p>
        ) : null}
        {state.agentProfileCatalogMode.mode === 'cwd' || state.agentProfileCatalogMode.mode === 'workspace' ? <div className="mt-2 w-full max-w-[var(--kiki-chat-content-width,760px)]">
          <AgentCapabilitiesPanel query={state.agentProfileCatalogMode.mode === 'cwd'
            ? { cwd: state.agentProfileCatalogMode.cwd, profile: state.agentProfile }
            : { workspace_id: state.agentProfileCatalogMode.workspaceId, profile: state.agentProfile }} />
        </div> : null}
      </div>

      {state.error !== null && slots.dock !== null
        ? createPortal(
            <div className="px-6 pb-1.5">
              <div className="mx-auto max-w-[var(--kiki-chat-content-width,760px)] rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-left font-mono text-[11.5px] text-danger">
                {state.error}
              </div>
            </div>,
            slots.dock,
          )
        : null}

      {(state.needsProviderSetup || recentSessions.length > 0) && slots.heroFooter !== null
        ? createPortal(
            <div className="px-6 pt-4">
              {state.needsProviderSetup ? <ProviderSetupCard /> : null}
              {recentSessions.length > 0 ? (
                <div className="mx-auto mt-4 max-w-[var(--kiki-chat-content-width,760px)]">
                  <p className="mb-2 text-center text-[11px] font-medium text-ink-soft">
                    {t('new.recent')}
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {recentSessions.map((session) => (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => void navigate(`/s/${session.id}`)}
                        className="max-w-[200px] truncate rounded-full border border-hairline bg-panel px-3 py-1 text-[11.5px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
                      >
                        {session.title !== '' ? session.title : session.last_prompt ?? session.id}
                      </button>
                    ))}
                    <button
                      type="button"
                      data-recent-more
                      onClick={() => { void navigate('/settings/workspaces'); }}
                      className="rounded-full border border-dashed border-hairline-strong px-3 py-1 text-[11.5px] text-ink-faint transition-colors hover:border-accent hover:text-accent"
                    >
                      {t('new.recentMore')}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>,
            slots.heroFooter,
          )
        : null}
    </>
  );
}

/**
 * NewSessionPage — the /new surface. One core action: start a conversation in
 * a workspace. Everything else is context arranged around it.
 *
 * The composer itself is NOT rendered here — this route publishes it into the
 * conversation shell's seat (same DOM node that docks at the bottom once the
 * first send lands on /s/:id). What this file owns is the chrome above the
 * card (wordmark + claim, then the target row: workspace, whose popover also
 * folds the dispatch diagnostic, and the per-draft switches) and the starters
 * hanging under it, portaled into the shell's
 * hero-footer slot. Recent sessions and the agent roster live elsewhere (the
 * sidebar, the composer's agent chip), so the page carries only what starts
 * this conversation.
 *
 * The workspace picker + send path come from the shared `useNewSessionDraft`
 * hook; /new is the single new-session surface (Ctrl+N and the sidebar button
 * navigate here).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';

import { Composer } from './Composer';
import { Icon } from './icons';
import { AgentCapabilitiesPanel } from './AgentCapabilitiesPanel';
import { ContextBreakdownProvider } from './ContextMeter';
import { useConversationShell, useRegisterSeat, type ConversationSeat } from './ConversationShell';
import { AUTO_WORKSPACE_ID, isAbsoluteCwdPath, WorkspacePickerFields, useNewSessionDraft, type NewSessionDraftState } from './NewSessionDraft';
import { Wordmark } from './Wordmark';
import { WorktreeOption } from './WorktreeOption';
import { EphemeralOption } from './EphemeralOption';
import { useI18n } from '../i18n';
import { staggerStyle } from '../lib/motion';
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
 * The hero's one signature: the wordmark's dot answers the person typing.
 * Each burst of input nods it once (throttled so a fast typist gets a calm
 * beat, not a flicker); the first render plays the arrival. Reduced motion
 * keeps it still (styles/new-session.css).
 */
function useTypingEcho(draft: string): number {
  const [echo, setEcho] = useState(0);
  const last = useRef({ draft, at: 0 });
  useEffect(() => {
    if (draft === last.current.draft) return;
    const now = Date.now();
    const grew = draft.length > last.current.draft.length;
    last.current.draft = draft;
    if (!grew || now - last.current.at < 480) return;
    last.current.at = now;
    setEcho((value) => value + 1);
  }, [draft]);
  return echo;
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
  const catalogMode = state.agentProfileCatalogMode;

  return (
    <div className="relative" data-hero-workspace>
      <button
        type="button"
        onClick={() => { setOpen((value) => !value); }}
        aria-label={t('hero.workspaceAria')}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="hero-workspace-chip motion-press flex h-8 max-w-[min(100%,360px)] items-center gap-1.5 rounded-md border border-transparent px-2.5 text-[13px] font-medium text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:h-11"
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
          {label ?? (state.autoWorkspace ? t('new.autoWorkspace') : state.workspacesLoading ? t('hero.workspaceLoading') : t('hero.chooseWorkspace'))}
        </span>
        <svg
          width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden
          className={`shrink-0 text-ink-faint transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="anim-enter absolute top-9 left-0 z-30 w-[26rem] max-w-[calc(100vw-32px)] rounded-[10px] border border-hairline bg-panel p-3 text-left shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]">
          <WorkspacePickerFields state={state} />
          {/* What the chosen agent can dispatch here depends on the target,
              so the diagnostic lives with the target, folded. */}
          {catalogMode.mode === 'cwd' || catalogMode.mode === 'workspace' ? (
            <div data-hero-capabilities className="mt-3 border-t border-hairline pt-2.5">
              <AgentCapabilitiesPanel query={catalogMode.mode === 'cwd'
                ? { cwd: catalogMode.cwd, profile: state.agentProfile }
                : { workspace_id: catalogMode.workspaceId, profile: state.agentProfile }} />
            </div>
          ) : null}
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
      className="mx-auto mt-2 w-full max-w-[var(--kiki-chat-content-width,760px)] rounded-[10px] border-l-2 border-accent bg-panel px-4 py-3 text-left"
    >
      <p className="font-display text-[16px] font-semibold tracking-tight text-ink">
        {t('new.setupTitle')}
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">{t('new.setupBody')}</p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => { void navigate('/settings/ai?tab=providers#st-card-auth'); }}
          className="motion-press h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-primary-foreground hover:bg-accent-deep focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none"
        >
          {t('new.setupSignIn')}
        </button>
        <button
          type="button"
          onClick={() => { void navigate('/settings/ai?tab=providers#st-card-providers-add'); }}
          className="motion-press h-8 rounded-md border border-hairline px-3 text-[13px] text-ink hover:border-hairline-strong focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
        >
          {t('new.setupApiKey')}
        </button>
      </div>
    </div>
  );
}

/**
 * Starters, contextualised by the current target: the first one names the
 * folder the session will actually run in, so it reads as this project rather
 * than a generic sample. They fill the draft; they never send on their own.
 */
function heroStarters(workspaceName: string | undefined): readonly {
  readonly key: string;
  readonly labelKey: 'new.starter.explain' | 'new.starter.explainNamed' | 'new.starter.review' | 'new.starter.fixTest' | 'new.starter.webSearch';
  readonly draftKey: 'new.starter.explainDraft' | 'new.starter.reviewDraft' | 'new.starter.fixTestDraft' | 'new.starter.webSearchDraft';
  readonly named?: boolean;
}[] {
  return [
    workspaceName === undefined
      ? { key: 'explain', labelKey: 'new.starter.explain', draftKey: 'new.starter.explainDraft' }
      : { key: 'explain', labelKey: 'new.starter.explainNamed', draftKey: 'new.starter.explainDraft', named: true },
    { key: 'review', labelKey: 'new.starter.review', draftKey: 'new.starter.reviewDraft' },
    { key: 'fixTest', labelKey: 'new.starter.fixTest', draftKey: 'new.starter.fixTestDraft' },
    { key: 'webSearch', labelKey: 'new.starter.webSearch', draftKey: 'new.starter.webSearchDraft' },
  ];
}

function focusComposer() {
  window.requestAnimationFrame(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-composer]');
    if (textarea === null) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
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
  const [searchParams] = useSearchParams();
  const workspaceParam = searchParams.get('workspace') ?? undefined;
  const agentParam = searchParams.get('agent') ?? undefined;
  const { slots } = useConversationShell();

  const state = useNewSessionDraft({ initialWorkspaceId: workspaceParam, initialProfile: agentParam, prefillNavigationKey });
  const echo = useTypingEcho(state.draft);

  // Only creation locks input. Catalog validation and missing targets block
  // sending while keeping the draft and selection controls editable.
  const composerDisabled = state.busy;
  const cwd = state.cwd.trim();
  const sendDisabled = cwd !== ''
    ? !isAbsoluteCwdPath(cwd)
    : state.effectiveWorkspace === undefined && !state.autoWorkspace;
  const showTargetHint = sendDisabled && !state.workspacesLoading;
  const mentionScopeKey = cwd !== '' ? `cwd:${cwd}` : `ws:${state.effectiveWorkspace?.id ?? ''}`;
  const starters = useMemo(() => heroStarters(workspaceChipLabel(state)), [state]);

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
          goalObjective={state.goalObjective}
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
          onChangeGoalObjective={state.setGoalObjective}
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
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-hairline text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink md:hidden pointer-coarse:h-11 pointer-coarse:w-11"
              >
                <Icon name="menu" size={16} />
              </button>
              <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-tight text-ink">
                {t('new.title')}
              </h1>
            </header>,
            slots.header,
          )
        : null}

      {/* Hero masthead: the wordmark as the composition's lead, the claim
          under it, then one quiet target row (where this session runs and the
          two per-draft switches). Left-aligned with the composer card as one
          stack; the stack is centred optically in the sheet, a little above
          true centre (styles/new-session.css). The dot arrives once and nods
          back while you type. The brand block carries its own transition name
          so it can fade out on its own when the first send hands off. */}
      <div data-hero-chrome className="mx-auto w-full max-w-[var(--kiki-chat-content-width,760px)] px-6 pb-5 text-left">
        <div className="flex min-w-0 flex-col">
          <div data-hero-brand className="flex min-w-0 flex-col">
            <span data-hero-masthead className="hero-wordmark inline-flex cursor-default self-start">
              <Wordmark size="xl" echo={echo} />
            </span>
            <p
              data-hero-headline
              className="mt-2 min-w-0 font-display text-[22px] leading-7 tracking-tight text-ink-soft"
              style={{ fontVariationSettings: '"opsz" 32' }}
            >
              {t('new.headline')}
            </p>
          </div>
          <div data-hero-target className="mt-5 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
            <span className="-ml-2.5 inline-flex"><HeroWorkspaceChip state={state} /></span>
            <EphemeralOption state={state} />
            <WorktreeOption state={state} />
          </div>
          {showTargetHint ? (
            <p className="mt-2 max-w-md text-[12px] text-ink-faint">{t('new.noTargetHint')}</p>
          ) : null}
          {state.workspaceId !== '' && state.workspaceId !== AUTO_WORKSPACE_ID && cwd === '' && !state.workspacesLoading && state.effectiveWorkspace === undefined ? (
            <p role="alert" className="mt-2 text-[12px] text-danger">{t('selection.workspaceInvalid', { value: state.workspaceId })}</p>
          ) : null}
        </div>
      </div>

      {state.error !== null && slots.dock !== null
        ? createPortal(
            <div className="px-6 pb-1.5">
              <div role="alert" className="mx-auto max-w-[var(--kiki-chat-content-width,760px)] rounded-md border-l-2 border-danger bg-danger/5 px-3 py-2 text-left text-[13px] text-danger">
                {state.error}
              </div>
            </div>,
            slots.dock,
          )
        : null}

      {slots.heroFooter !== null
        ? createPortal(
            <div className="px-6">
              {/* Starters belong to the composer: they only fill its draft, so
                  they hang 8px under the card with no heading of their own and
                  never send. Quiet at rest (text only), a neutral wash on hover. */}
              <div className="mx-auto max-w-[var(--kiki-chat-content-width,760px)] text-left">
                <div
                  role="group"
                  aria-label={t('new.startersAria')}
                  data-hero-starters
                  className="motion-stagger -mx-1 mt-2 flex flex-wrap gap-x-0.5 gap-y-1"
                >
                  {starters.map((starter, index) => (
                    <button
                      key={starter.key}
                      type="button"
                      data-hero-starter
                      style={staggerStyle(index)}
                      onClick={() => {
                        state.updateDraft(t(starter.draftKey));
                        focusComposer();
                      }}
                      className="motion-press h-7 rounded-md px-2 text-[13px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:h-11"
                    >
                      {starter.named === true
                        ? t('new.starter.explainNamed', { name: workspaceChipLabel(state) ?? '' })
                        : t(starter.labelKey)}
                    </button>
                  ))}
                </div>
              </div>

              {state.needsProviderSetup ? <div className="mt-6"><ProviderSetupCard /></div> : null}
            </div>,
            slots.heroFooter,
          )
        : null}
    </>
  );
}

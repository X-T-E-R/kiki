/**
 * NewSessionPage — the /new surface. One core action: start a conversation in
 * a workspace. Everything else is context arranged around it.
 *
 * The composer itself is NOT rendered here — this route publishes it into the
 * conversation shell's seat (same DOM node that docks at the bottom once the
 * first send lands on /s/:id). What this file owns is the chrome above the
 * card (wordmark + claim + the live pulse line) and the band below it
 * (contextual starters, continuable sessions, the available team), portaled
 * into the shell's hero-footer slot.
 *
 * The workspace picker + send path come from the shared `useNewSessionDraft`
 * hook; /new is the single new-session surface (Ctrl+N and the sidebar button
 * navigate here).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import type { NamedAgentProfile, Session } from '@kiki/protocol';

import { Composer, DEFAULT_AGENT_PROFILE } from './Composer';
import { Icon } from './icons';
import { AgentCapabilitiesPanel } from './AgentCapabilitiesPanel';
import { ContextBreakdownProvider } from './ContextMeter';
import { useConversationShell, useRegisterSeat, type ConversationSeat } from './ConversationShell';
import { AUTO_WORKSPACE_ID, isAbsoluteCwdPath, WorkspacePickerFields, useNewSessionDraft, type NewSessionDraftState } from './NewSessionDraft';
import { RelativeTime } from './RelativeTime';
import { LifeMark } from './LifeMark';
import { Wordmark } from './Wordmark';
import { WorktreeOption } from './WorktreeOption';
import { useI18n } from '../i18n';
import { agentProfileCatalogQueryKey, loadAgentProfileCatalog } from '../lib/agentProfileCatalog';
import { aggregateLife, lifeOf, staggerStyle, type LifeState } from '../lib/motion';
import { requestSessionSearch } from '../lib/sidebarSearch';
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

/** /new paints "just finished" in success (a ring); the shell's default is ink. */
const NEW_LIFE_TONE = { done: 'border-success' } as const;

/**
 * The state word each continuation row carries after its title, so the
 * band's order (needs you → working → finished → the rest) reads in words,
 * not only in marks. Waiting is the one word that takes weight and accent.
 */
const LIFE_WORD_CLASS: Record<Exclude<LifeState, 'idle'>, string> = {
  waiting: 'font-medium text-attention',
  working: 'text-ink-soft',
  done: 'text-success',
  failed: 'text-danger',
};

/**
 * The fixed status column every continuation row reserves, so titles share
 * one axis whether or not a row has a mark (idle draws nothing).
 */
function RowMark({ id, life }: { id: string; life: LifeState }) {
  return (
    <span aria-hidden className="flex w-[7px] shrink-0 justify-center">
      <LifeMark markId={`new-row:${id}`} life={life} still tone={life === 'done' ? NEW_LIFE_TONE.done : undefined} />
    </span>
  );
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

/** True where the sidebar sits beside the page (the `md` breakpoint). */
function sidebarIsDocked(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 768px)').matches;
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
        className="hero-workspace-chip motion-press flex h-8 max-w-[min(100%,360px)] items-center gap-1.5 rounded-md border border-transparent px-2.5 text-[13px] font-medium text-ink focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none pointer-coarse:h-11"
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
          className="motion-press h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-primary-foreground hover:bg-accent-deep focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:outline-none"
        >
          {t('new.setupSignIn')}
        </button>
        <button
          type="button"
          onClick={() => { void navigate('/settings/ai?tab=providers#st-card-providers-add'); }}
          className="motion-press h-8 rounded-md border border-hairline px-3 text-[13px] text-ink hover:border-hairline-strong focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
        >
          {t('new.setupApiKey')}
        </button>
      </div>
    </div>
  );
}

/**
 * Quiet row: text only at rest, a neutral wash on hover. The list bleeds 8px
 * past the band edge (-mx-2) so row text sits on the same axis as the band
 * heading while the wash still has room around it. Rows never take the press
 * sink; accent never washes a resting control (accent means "needs you").
 */
const BAND_ROW_CLASS =
  'flex min-h-8 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-[var(--kiki-motion-quick)] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none pointer-coarse:min-h-11';

/** Secondary "go elsewhere" link, sitting right after its heading. */
const BAND_LINK_CLASS =
  'rounded-sm px-1 py-1 -my-1 text-[12px] leading-4 text-ink-faint transition-colors duration-[var(--kiki-motion-quick)] hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none pointer-coarse:py-3 pointer-coarse:-my-3';

/** Quiet band note (loading / empty): a plain T4 line, no container. */
const BAND_NOTE_CLASS = 'py-1.5 text-[12px] leading-5 text-ink-faint';

/**
 * One section of the band. Every section shares this header — the label tier
 * (12px / 500 / ink-soft, no caps, no tracking: caps do nothing for CJK) and
 * an optional secondary link directly after the title on the same line, so a
 * link never floats at a column edge its content does not reach.
 */
function BandSection({
  id,
  title,
  link,
  children,
  ...data
}: {
  id: string;
  title: string;
  link?: { readonly label: string; readonly onClick: () => void; readonly hook: string };
  children: React.ReactNode;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  return (
    <section aria-labelledby={`${id}-heading`} className="min-w-0" {...data}>
      <div className="mb-2 flex min-w-0 items-baseline gap-1.5">
        <h2 id={`${id}-heading`} className="min-w-0 truncate text-[12px] leading-4 font-medium text-ink-soft">
          {title}
        </h2>
        {link === undefined ? null : (
          <>
            <span aria-hidden className="text-[12px] leading-4 text-ink-faint">·</span>
            <button type="button" onClick={link.onClick} className={BAND_LINK_CLASS} {...{ [link.hook]: '' }}>
              {link.label}
            </button>
          </>
        )}
      </div>
      {children}
    </section>
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

/**
 * The continuation band: sessions you can walk back into, each carrying the
 * state it is actually in. A session that needs you sorts first — that is the
 * one piece of work the page can move forward besides starting something new
 * — then running work, then what just finished, then the rest by recency.
 *
 * Every row that is in a state says it twice, once in shape (dot / ring /
 * square) and once in a short word, so the order explains itself. Only
 * waiting takes weight and accent; idle draws nothing and keeps the column.
 */
function ContinueBand({
  sessions,
  loading,
  onOpen,
  onOpenList,
}: {
  sessions: readonly Session[];
  loading: boolean;
  onOpen: (id: string) => void;
  onOpenList: () => void;
}) {
  const { t } = useI18n();
  const ranked = useMemo(() => {
    const weight = (session: Session) => {
      const life = lifeOf(session);
      return life === 'waiting' ? 0 : life === 'working' ? 1 : life === 'done' ? 2 : life === 'failed' ? 3 : 4;
    };
    return [...sessions].sort((a, b) => weight(a) - weight(b)).slice(0, 4);
  }, [sessions]);

  return (
    <BandSection
      id="hero-continue"
      title={t('new.continue')}
      link={ranked.length > 0 ? { label: t('new.recentMore'), onClick: onOpenList, hook: 'data-recent-more' } : undefined}
      data-hero-recents
    >
      {ranked.length === 0 ? (
        <p className={BAND_NOTE_CLASS}>{loading ? t('hero.workspaceLoading') : t('new.continueEmpty')}</p>
      ) : (
        <ul className="motion-stagger -mx-2 flex flex-col gap-0.5">
          {ranked.map((session, index) => {
            const life = lifeOf(session);
            const title = session.title !== '' ? session.title : session.last_prompt ?? session.id;
            const stateLabel = life === 'idle' ? undefined : t(
              life === 'waiting' ? 'new.life.waiting'
                : life === 'working' ? 'new.life.working'
                : life === 'done' ? 'new.life.done'
                : 'new.life.failed',
            );
            return (
              <li key={session.id} style={staggerStyle(index)}>
                <button
                  type="button"
                  data-hero-recent
                  data-life={life}
                  onClick={() => { onOpen(session.id); }}
                  className={`${BAND_ROW_CLASS} group hover:bg-ink/[0.04]`}
                >
                  <RowMark id={session.id} life={life} />
                  <span className={`min-w-0 truncate text-[13px] leading-5 ${life === 'waiting' ? 'font-medium text-ink' : life === 'idle' ? 'text-ink-soft' : 'text-ink'}`}>
                    {title}
                  </span>
                  {life !== 'idle' && stateLabel !== undefined ? (
                    <span data-hero-recent-state className={`shrink-0 text-[12px] leading-4 ${LIFE_WORD_CLASS[life]}`}>{stateLabel}</span>
                  ) : null}
                  <span className="min-w-2 flex-1" />
                  <RelativeTime at={session.updated_at} className="shrink-0 text-[12px] leading-4 text-ink-faint tabular-nums" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </BandSection>
  );
}

/**
 * The team band: who is available in this target. Main profiles are the ones
 * that can lead the conversation (clicking one binds it to the draft, the same
 * write the composer's own picker performs); non-main profiles are named as
 * what the lead can bring in, which is the concrete shape of "your agents".
 *
 * Same row shape as the continuation band. The lead in charge is told apart
 * by a lifted sheet and weight, not by a coloured container or a status dot;
 * the ones it can bring in are a plain line underneath.
 */
function TeamBand({ state }: { state: NewSessionDraftState }) {
  const { t } = useI18n();
  const { client } = useConnection();
  const navigate = useNavigate();
  const mode = state.agentProfileCatalogMode;

  const catalog = useQuery({
    queryKey: agentProfileCatalogQueryKey(mode),
    queryFn: () => loadAgentProfileCatalog(client, mode),
    enabled: mode.mode !== 'disabled',
    staleTime: 60_000,
    retry: false,
  });

  const { leads, helpers } = useMemo(() => {
    const items: readonly NamedAgentProfile[] = catalog.data?.items ?? [];
    const usable = items.filter((item) => !item.disabled);
    return {
      leads: usable.filter((item) => item.main === true),
      helpers: usable.filter((item) => item.main !== true),
    };
  }, [catalog.data]);

  const profileLabel = (name: string) => (name === DEFAULT_AGENT_PROFILE ? t('composer.agentDefaultName') : name);
  // A plain enumeration of names ("reviewer、research"), no "and".
  const helperNames = helpers.slice(0, 6).map((item) => item.name).join(t('taskBoard.listSeparator'));

  return (
    <BandSection
      id="hero-team"
      title={t('new.team')}
      link={{ label: t('new.teamManage'), onClick: () => { void navigate('/settings/agents'); }, hook: 'data-hero-team-manage' }}
      data-hero-team
    >
      {catalog.isPending && mode.mode !== 'disabled' ? (
        <p role="status" className={BAND_NOTE_CLASS}>{t('new.teamLoading')}</p>
      ) : leads.length === 0 && helpers.length === 0 ? (
        <p className={BAND_NOTE_CLASS}>{t('new.teamEmpty')}</p>
      ) : (
        <>
          <ul className="motion-stagger -mx-2 flex flex-col gap-0.5">
            {leads.map((item, index) => {
              const active = item.name === state.agentProfile;
              const hint = item.when_to_use ?? item.description;
              return (
                <li key={item.name} style={staggerStyle(index)}>
                  <button
                    type="button"
                    data-hero-team-lead={item.name}
                    aria-pressed={active}
                    aria-label={t('new.teamPickAria', { name: profileLabel(item.name) })}
                    title={hint}
                    onClick={() => { state.setAgentProfile(item.name); }}
                    className={`${BAND_ROW_CLASS} ${
                      active ? 'bg-panel shadow-[var(--kiki-sheet-shadow)]' : 'hover:bg-ink/[0.04]'
                    }`}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={`truncate text-[13px] leading-5 ${active ? 'font-medium text-ink' : 'text-ink-soft'}`}>
                        {profileLabel(item.name)}
                      </span>
                      {hint === undefined ? null : (
                        <span className="truncate text-[12px] leading-4 text-ink-faint">{hint}</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {helpers.length > 0 ? (
            <p data-hero-team-helpers className="mt-1.5 min-w-0 text-[12px] leading-5 text-ink-faint">
              {t('new.teamHelpersLine', { names: helperNames })}
            </p>
          ) : null}
        </>
      )}
    </BandSection>
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
  const { t, tp } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const workspaceParam = searchParams.get('workspace') ?? undefined;
  const agentParam = searchParams.get('agent') ?? undefined;
  const { slots } = useConversationShell();

  const state = useNewSessionDraft({ initialWorkspaceId: workspaceParam, initialProfile: agentParam, prefillNavigationKey });
  const echo = useTypingEcho(state.draft);

  // "All sessions" lands in the one session list, the sidebar: it opens its
  // search there. On narrow windows the sidebar is a drawer, so open it too.
  const openSessionList = () => {
    if (!sidebarIsDocked()) onToggleSidebar();
    requestSessionSearch();
  };

  const recentQuery = useQuery({
    queryKey: ['sessions', 'recent'],
    queryFn: () => client.listSessions({ page_size: 8 }),
    staleTime: 5000,
  });
  const recentSessions = useMemo(() => recentQuery.data?.items ?? [], [recentQuery.data]);

  // The pulse line: what the team is doing right now, in one sentence. It
  // reports facts already on screen elsewhere (the sidebar's rows), so it
  // never becomes the only place a waiting session is visible.
  const pulse = useMemo(() => {
    const lives = recentSessions.map((session) => lifeOf(session));
    const life = aggregateLife(lives);
    const waiting = lives.filter((value) => value === 'waiting').length;
    const working = lives.filter((value) => value === 'working').length;
    const text = waiting > 0 ? tp('new.pulse.waiting', waiting)
      : working > 0 ? tp('new.pulse.working', working)
      : t('new.pulse.ready');
    return { life, text };
  }, [recentSessions, t, tp]);

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

      {/* Hero masthead — the page's one large object, left-aligned with the
          composer card as one stack. The wordmark is set big (the brand's
          own mark as the composition's lead), the claim sits under it as the
          product's one line, then the target and the team's pulse. The dot
          is alive: it carries the team's state, arrives once, and nods back
          while you type. The stack is anchored so the composer's centre sits
          at ~43% of the sheet (styles/new-session.css). */}
      <div data-hero-chrome className="mx-auto w-full max-w-[var(--kiki-chat-content-width,760px)] px-6 pb-4 text-left">
        <div className="flex min-w-0 flex-col">
          <span data-hero-masthead className="hero-wordmark inline-flex cursor-default self-start">
            <Wordmark size="xl" life={pulse.life === 'idle' ? undefined : pulse.life} echo={echo} />
          </span>
          <p
            data-hero-headline
            className="mt-2 min-w-0 font-display text-[22px] leading-7 tracking-tight text-ink-soft"
            style={{ fontVariationSettings: '"opsz" 32' }}
          >
            {t('new.headline')}
          </p>
          <div className="mt-4 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="-ml-2.5 inline-flex"><HeroWorkspaceChip state={state} /></span>
            <span data-hero-pulse className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-faint">
              {/* The wordmark's dot is the page's one breathing mark; this one
                  names the same state in words, so it holds still. */}
              <LifeMark markId="new-pulse" life={pulse.life} still />
              <span className="truncate">{pulse.text}</span>
            </span>
          </div>
          <WorktreeOption state={state} />
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
                      className="motion-press h-7 rounded-md px-2 text-[13px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none pointer-coarse:h-11"
                    >
                      {starter.named === true
                        ? t('new.starter.explainNamed', { name: workspaceChipLabel(state) ?? '' })
                        : t(starter.labelKey)}
                    </button>
                  ))}
                </div>
              </div>

              {state.needsProviderSetup ? <div className="mt-6"><ProviderSetupCard /></div> : null}

              <div data-hero-bands className="mx-auto mt-6 flex max-w-[var(--kiki-chat-content-width,760px)] flex-col gap-6 text-left">
                {/* Container query, not a viewport one: the column's real width
                    depends on the sidebar and the window together, and session
                    titles start truncating badly below ~620px of band. */}
                <div className="@container/band min-w-0">
                  <div className="grid min-w-0 gap-6 @[620px]/band:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] @[620px]/band:gap-8">
                    <ContinueBand
                      sessions={recentSessions}
                      loading={recentQuery.isPending}
                      onOpen={(id) => { void navigate(`/s/${id}`); }}
                      onOpenList={openSessionList}
                    />
                    <TeamBand state={state} />
                  </div>
                </div>

                {/* The dispatch-capabilities diagnostic stays reachable but folded,
                    last and quiet — it never competes with the composer. No
                    opacity on text: faint already sits at the AA floor. */}
                {state.agentProfileCatalogMode.mode === 'cwd' || state.agentProfileCatalogMode.mode === 'workspace' ? (
                  <div data-hero-capabilities className="-mx-1 w-full">
                    <AgentCapabilitiesPanel query={state.agentProfileCatalogMode.mode === 'cwd'
                      ? { cwd: state.agentProfileCatalogMode.cwd, profile: state.agentProfile }
                      : { workspace_id: state.agentProfileCatalogMode.workspaceId, profile: state.agentProfile }} />
                  </div>
                ) : null}
              </div>
            </div>,
            slots.heroFooter,
          )
        : null}
    </>
  );
}

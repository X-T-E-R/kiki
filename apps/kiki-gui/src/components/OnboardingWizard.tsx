/**
 * OnboardingWizard — the first-run dialog, three steps that each say one thing:
 * what Kiki can help you do (the same four uses the discovery routes are named
 * after, with language as one small control and the existing appearance
 * choices folded behind one row, still applied live), how much it may do on
 * its own (default permission mode), and where to look around first. There is
 * no workspace question: /new already defaults to the most recent workspace,
 * else a fresh folder in Kiki Home.
 *
 * The last step lists the five discovery routes themselves, one quiet row
 * each, straight from the shared catalog. A row starts that route through the
 * same DiscoveryContext the /discover hub and the sidebar entry use, so the
 * welcome invents no second flow, progress store, or resume state — and the
 * run ends only once the guarded navigation commits: a cancelled dirty-draft
 * prompt leaves both the wizard and the tour untouched, while a route that
 * genuinely cannot start (offline with no local example) says so in place
 * instead of failing silent. The hub still owns the resume banner and the
 * model connection — read from the server's own `auth` and provider probes —
 * so the welcome grows no second copy of either. Connecting a model happens
 * where it is needed, in the existing Connections card that already owns
 * account sign-in and the API-key form; nothing in this run writes a
 * provider, and the current model and settings stay untouched.
 *
 * Every primary advance button persists the current step before moving on, so
 * leaving the wizard after any Next loses nothing. Nothing here holds an
 * unsubmitted form any more, so no exit path can discard one: the dialog is
 * deliberately not dismissible, and leaves on the header's close button or on
 * an explicit action inside it.
 *
 * "Set up later" is about the current step, not the run: it steps past that
 * step to the next one and keeps walking, because that is what "later" says.
 * The first step asks nothing, so it carries only Next. On the last step,
 * where there is no next step, the same slot reads "Not now" and closes.
 *
 * Two entries: the App shell auto-opens it when the auth/models probes report
 * a server with nothing to answer with (`shouldOfferOnboarding`), and the
 * settings About page re-opens it through `requestOnboardingOpen`. Every exit
 * path — a started route, X, or Not now — marks the run completed
 * (`kiki.onboarding` in localStorage), so the auto-popup fires at most once.
 * Stepping past a step is not an exit: the run stays unfinished until one of
 * those paths is taken, so a half-walked wizard can still be completed.
 */

import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { AuthSummary, PermissionMode } from '@kiki/protocol';
import {
  DISCOVERY_ROUTES,
  discoveryRoute,
  discoveryRouteProgress,
  type DiscoveryRouteId,
} from '@kiki/session-core/discovery';
import { errorText, type I18nKey, type Locale } from '@kiki/session-core/i18n';
import {
  isOnboardingCompleted,
  markOnboardingCompleted,
  readSettings,
  writeSettings,
} from '@kiki/session-core/settings';
import type { KikiConfigResponse } from '@kiki/session-core/transport';

import { useI18n } from '../i18n';
import { Icon } from './icons';
import { PERMISSION_MODES, RECOMMENDED_PERMISSION_MODE } from '../lib/permissionModes';
import { useConnection } from '../state/connection';
import { Dialog } from './Dialog';
import { DiscoveryRouteRow, useDiscovery } from './discovery';
import { OnboardingAppearanceStep } from './OnboardingAppearanceStep';
import { needsProviderSetup } from './NewSessionDraft';
import { FeedbackLine, type Feedback } from './controls';
import { DirtyGuardContext } from './dirtyGuard';
import { mergeConfigEcho } from './settings/configEcho';
import { SettingsSegmented } from './settings/SettingsPrimitives';
import { PRIMARY_BUTTON as SHARED_PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';
import { Wordmark } from './Wordmark';

// On the dark accent white text falls below AA; the on-accent ink holds it.
const PRIMARY_BUTTON = `${SHARED_PRIMARY_BUTTON} dark:text-primary-foreground`;

const STEPS = ['welcome', 'permissions', 'discover'] as const;
type OnboardingStep = (typeof STEPS)[number];

const STEP_TITLE_KEYS = {
  welcome: 'onboarding.intro.title',
  permissions: 'onboarding.step.permissions',
  discover: 'onboarding.step.discover',
} as const;

/**
 * The first step's four uses. Each one borrows its name from the discovery
 * route that shows it, so the word a person reads here is the word on the
 * closing step, the /discover hub and the README — one narrative, one set of
 * names. Only the one-line description is the welcome's own.
 */
const INTRO_USES: readonly { readonly routeId: DiscoveryRouteId; readonly lineKey: I18nKey }[] = [
  { routeId: 'do-first', lineKey: 'onboarding.intro.doFirst' },
  { routeId: 'understand', lineKey: 'onboarding.intro.understand' },
  { routeId: 'sustain', lineKey: 'onboarding.intro.sustain' },
  { routeId: 'extend', lineKey: 'onboarding.intro.extend' },
];

/**
 * The auto-popup rule: only while the server provably has nothing to answer
 * with (needsProviderSetup's both-probes-agreed rule) and onboarding never
 * completed. Pending or failed probes stay silent — a late popup costs less
 * than a wrong one.
 */
export function shouldOfferOnboarding(input: {
  readonly completed: boolean;
  readonly auth: AuthSummary | undefined;
  readonly models: readonly unknown[] | undefined;
}): boolean {
  if (input.completed) return false;
  return needsProviderSetup(input.auth, input.models);
}

// Manual re-entry (settings → about) crosses from the settings tree to the App
// shell through a tiny module channel — the same pattern as lib/toasts.
const openListeners = new Set<() => void>();

export function requestOnboardingOpen(): void {
  for (const listener of openListeners) listener();
}

export function subscribeOnboardingOpenRequests(listener: () => void): () => void {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
}

function StepDots({ step }: { step: OnboardingStep }) {
  const { t } = useI18n();
  const index = STEPS.indexOf(step);
  return (
    <div
      className="flex items-center gap-1.5"
      role="group"
      aria-label={t('onboarding.progress', { current: index + 1, total: STEPS.length })}
    >
      {STEPS.map((id, dotIndex) => (
        <span
          key={id}
          aria-hidden
          className={`h-1.5 rounded-full transition-all ${
            dotIndex === index
              ? 'w-5 bg-selected-ink'
              : dotIndex < index
                ? 'w-1.5 bg-ink-faint'
                : 'w-1.5 bg-hairline-strong'
          }`}
        />
      ))}
      <span aria-hidden className="ml-1.5 hidden text-[12px] tabular-nums text-ink-faint sm:inline">
        {t('onboarding.progress', { current: index + 1, total: STEPS.length })}
      </span>
    </div>
  );
}

/**
 * Selection mark shared by the radio cards: an empty ring at rest, an
 * ink-blue check once chosen — "this is the current choice", never the accent.
 */
function ChoiceMark({ selected }: { readonly selected: boolean }) {
  return (
    <span
      aria-hidden
      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors ${
        selected ? 'bg-selected-ink text-paper' : 'ring-1 ring-inset ring-hairline-strong'
      }`}
    >
      {selected ? <Icon name="check" size={12} /> : null}
    </span>
  );
}

const CHOICE_CARD =
  'flex w-full items-start gap-2 rounded-[10px] px-3 py-2 text-left transition-[background-color,box-shadow] duration-[var(--kiki-motion-quick)] focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60';
const CHOICE_CARD_SELECTED = 'bg-paper shadow-[var(--kiki-sheet-shadow)]';
const CHOICE_CARD_IDLE = 'hover:bg-ink/[0.04]';

/** One permission-mode radio row: the mode label plus its one-line meaning. */
function PermissionOption({
  mode,
  selected,
  recommended,
  disabled,
  onSelect,
}: {
  readonly mode: PermissionMode;
  readonly selected: boolean;
  readonly recommended: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      data-permission-choice={mode}
      className={`${CHOICE_CARD} ${selected ? CHOICE_CARD_SELECTED : CHOICE_CARD_IDLE}`}
    >
      <ChoiceMark selected={selected} />
      <span className="min-w-0">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className={`text-[13px] text-ink ${selected ? 'font-medium' : ''}`}>
            {t(`composer.perm.${mode}`)}
          </span>
          {recommended ? (
            <span className="rounded-[4px] bg-ink/[0.06] px-1.5 py-px text-[11px] font-medium text-ink-soft">
              {t('onboarding.permissions.recommended')}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-soft">
          {t(`onboarding.permissions.${mode}.line`)}
        </span>
      </span>
    </button>
  );
}


export function OnboardingWizard({ onClose }: { readonly onClose: () => void }) {
  const { client } = useConnection();
  const { t, locale, setLocale } = useI18n();
  const { state: discoveryState, startRoute } = useDiscovery();
  const dirtyGuard = useContext(DirtyGuardContext);
  const queryClient = useQueryClient();
  const [step, setStep] = useState<OnboardingStep>('welcome');
  // Appearance stays complete but folded: the first screen answers "what is
  // this for", and the look is one row away for whoever wants it now.
  const [appearanceOpen, setAppearanceOpen] = useState(false);

  // Whether the step still has content below the fold, so the edge can say so.
  const stepScrollRef = useRef<HTMLDivElement>(null);
  const [stepScrollsMore, setStepScrollsMore] = useState(false);
  const noteStepScroll = useCallback(() => {
    const node = stepScrollRef.current;
    if (node === null) return;
    setStepScrollsMore(node.scrollHeight - node.clientHeight - node.scrollTop > 8);
  }, []);

  /**
   * "There is more below" is a fact about the laid-out box, not about the last
   * scroll gesture, so it is measured whenever the step arrives, its content
   * changes (a step swap, a disclosure opening, an install row appearing) or
   * the window resizes. Measuring only on scroll would leave a tall first
   * screen claiming there was nothing below it until the pointer moved.
   */
  useLayoutEffect(() => {
    const node = stepScrollRef.current;
    if (node === null) return;
    noteStepScroll();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { noteStepScroll(); });
    observer.observe(node);
    for (const child of Array.from(node.children)) observer.observe(child);
    // Step content swaps wholesale on most changes, so a child-only observer
    // would miss a taller body that replaced a short one. Any real change
    // lands in a re-render of this panel; measure then too.
    return () => { observer.disconnect(); };
  }, [step, noteStepScroll, locale, appearanceOpen]);

  // A fresh run (auto-popup, onboarding never completed) defaults the
  // permission choice to auto; a replay from Settings shows the server's
  // explicit value untouched.
  const freshRun = useRef(!isOnboardingCompleted());
  const permissionTouched = useRef(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => readSettings().defaultPermissionMode,
  );
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [permissionFeedback, setPermissionFeedback] = useState<Feedback>(null);
  const [discoverBusy, setDiscoverBusy] = useState(false);
  const [discoverFeedback, setDiscoverFeedback] = useState<Feedback>(null);

  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  useEffect(() => {
    if (permissionTouched.current) return;
    const mode = configQuery.data?.default_permission_mode;
    if (mode !== 'manual' && mode !== 'auto' && mode !== 'yolo') return;
    // A first run upgrades a manual server preference to the recommended auto
    // choice; reopening from Settings preserves an explicit manual preference.
    setPermissionMode(freshRun.current && mode === 'manual' ? 'auto' : mode);
  }, [configQuery.data]);

  const close = useCallback(() => {
    markOnboardingCompleted();
    onClose();
  }, [onClose]);

  // Leaving the run. Backdrop clicks and a bare Escape never reach here (the
  // Dialog is `dismissible={false}`): the header's close and the footer's
  // last-step "Set up later" are the only ways out, so neither a stray click
  // nor an interrupted thought can mark the first run done behind the user.
  //
  // A picker still owns Escape while it is open. Its panel is portaled to
  // <body>, so its own keydown handler cannot see a key pressed anywhere else on
  // the page — the window listener below is what closes it, and it acts on the
  // panel alone. The wizard itself never closes here.
  const dismiss = useCallback(() => {
    const openPicker = document.querySelector<HTMLButtonElement>(
      '[role="dialog"] [data-searchable-select] > button[aria-expanded="true"]',
    );
    if (openPicker !== null) {
      openPicker.click();
      openPicker.focus();
      return;
    }
    close();
  }, [close]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const openPicker = document.querySelector<HTMLButtonElement>(
        '[role="dialog"] [data-searchable-select] > button[aria-expanded="true"]',
      );
      if (openPicker === null) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => { window.removeEventListener('keydown', onKeyDown, true); };
  }, [dismiss]);


  /** The permission step's save: the selection lands in the server config. */
  const savePermissionMode = async (): Promise<boolean> => {
    setPermissionBusy(true);
    setPermissionFeedback(null);
    try {
      const echoed = await client.patchConfig({ default_permission_mode: permissionMode });
      const merged = mergeConfigEcho(
        queryClient.getQueryData<KikiConfigResponse>(['config']) ?? configQuery.data,
        echoed,
      );
      queryClient.setQueryData(['config'], merged);
      const echoedMode = merged.default_permission_mode;
      if (echoedMode === 'manual' || echoedMode === 'auto' || echoedMode === 'yolo') {
        writeSettings({ defaultPermissionMode: echoedMode });
      }
      return true;
    } catch (error) {
      setPermissionFeedback({ tone: 'error', text: errorText(locale, error) });
      return false;
    } finally {
      setPermissionBusy(false);
    }
  };

  const goNext = async () => {
    if (step === 'welcome') {
      setStep('permissions');
      return;
    }
    // The permission default is saved on leaving its step, so the closing
    // invitation after it never holds anything unsaved.
    if (step === 'permissions' && await savePermissionMode()) {
      setStep('discover');
    }
  };

  /**
   * "Set up later" leaves the *step*, not the run.
   *
   * The action is about this step's one question, so it answers that question
   * the way "not now" does everywhere else in Kiki — step past it — and the
   * walk continues to the finish. Closing the whole wizard here discarded the
   * steps the user had not reached yet and left them re-running from the top,
   * which is not what the label promises. On the last step there is no next
   * step to move to, so it keeps the original meaning and closes.
   *
   * The permission step saves like any other advance: its default is a choice
   * already made, and skipping past it must not silently discard it. A failed
   * save keeps the step, so the choice is never lost behind the skip.
   */
  const skipStep = async () => {
    const index = STEPS.indexOf(step);
    if (index === STEPS.length - 1) {
      close();
      return;
    }
    if (step === 'permissions' && !await savePermissionMode()) return;
    setStep(STEPS[index + 1]!);
  };

  /**
   * A route row starts that route right there: the shared DiscoveryContext
   * owns the state, the guarded navigation and the persistence, so the wizard
   * only decides what the outcome means for itself. A committed start ends the
   * run like any other explicit exit. A cancelled one — the dirty-draft prompt
   * answered with "stay" — is the user choosing to remain here, so it stays
   * silent; anything else (offline with no local example, a navigation that
   * failed) gets a recovery line, or the row reads as dead.
   */
  const startDiscoveryRoute = async (routeId: DiscoveryRouteId) => {
    setDiscoverBusy(true);
    setDiscoverFeedback(null);
    try {
      const started = await startRoute(routeId);
      if (started) {
        markOnboardingCompleted();
        onClose();
      } else if (dirtyGuard?.dirty !== true) {
        setDiscoverFeedback({ tone: 'error', text: t('onboarding.discover.unavailable') });
      }
    } finally {
      setDiscoverBusy(false);
    }
  };

  const stepIndex = STEPS.indexOf(step);
  const last = stepIndex === STEPS.length - 1;

  return (
    <Dialog
      onClose={dismiss}
      ariaLabel={t('onboarding.title')}
      overlayId="onboarding-wizard"
      // This run ends when it closes, and it carries choices the user has made
      // about their own setup, so it leaves on the header's close button or on
      // an explicit action inside it — never on a backdrop click or a stray
      // Escape, which used to end the first run behind the user's back.
      dismissible={false}
      // Same chrome as DIALOG_PANEL_BASE, minus the padding: the wizard owns
      // its header/body/footer insets so the scroll region meets the dividers.
      // A cap, not a fixed height: a short step keeps the panel short instead of
      // reserving an empty 85vh, and a tall one still scrolls inside the cap.
      panelClassName="anim-enter flex max-h-[85vh] min-h-0 w-full max-w-[680px] flex-col rounded-2xl border border-hairline bg-panel shadow-[0_16px_48px_-16px_rgb(var(--kiki-shadow-ink)/0.35)]"
    >
      {/* The full masthead greets once, on the first step. After that the
          header is the wordmark and the step dots only, so a step never opens
          under two stacked titles. */}
      <div
        className={`flex shrink-0 justify-between gap-4 border-b border-hairline px-6 ${
          step === 'welcome' ? 'items-start pb-4 pt-5' : 'items-center pb-3 pt-3.5'
        }`}
        data-onboarding-header={step === 'welcome' ? 'full' : 'compact'}
      >
        <div className="min-w-0">
          <span className="inline-flex" aria-hidden>
            <Wordmark size="md" />
          </span>
          {step === 'welcome' ? (
            <>
              <h2 className="mt-1.5 font-display text-[18px] font-semibold tracking-tight text-ink">
                {t('onboarding.title')}
              </h2>
              <p className="mt-0.5 text-[12px] text-ink-soft">{t('onboarding.intro.subtitle')}</p>
            </>
          ) : null}
        </div>
        <div className={`flex shrink-0 items-center gap-3 ${step === 'welcome' ? 'pt-1' : ''}`}>
          <StepDots step={step} />
          <button
            type="button"
            onClick={close}
            aria-label={t('onboarding.close')}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-hairline text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
          >
            <Icon name="close" />
          </button>
        </div>
      </div>

      {/* The step is taller than the dialog on a short window, so the edge says
          so while there is more below: a soft fade over the panel ground, the
          same mask the composer seat uses. No text, and it disappears the
          moment the end is reached. */}
      {/* `min-h-0` lets this flex child shrink so the step scrolls inside its
          own box and the footer below keeps its row, however long the step is.
          `grow shrink` keeps an automatic basis, so a short step contributes its
          own height to the panel and the cap only bites when the content is
          taller than the window. */}
      <div className="relative min-h-0 shrink grow overflow-hidden">
        <div
          ref={stepScrollRef}
          data-onboarding-step-scroll
          onScroll={noteStepScroll}
          className="h-full min-h-0 overflow-y-auto px-6 py-3"
        >
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h3 className="font-display text-[15px] leading-5 font-semibold text-ink">{t(STEP_TITLE_KEYS[step])}</h3>
          {/* Language is the one choice that changes how everything below
              reads, so it stays on the first screen — as one small switch
              beside the title, not as the first row of a form. */}
          {step === 'welcome' ? (
            <div className="flex items-center gap-2" data-onboarding-language>
              <span id="onboarding-language-label" className="text-[12px] text-ink-faint">
                {t('st.language.title')}
              </span>
              <SettingsSegmented<Locale>
                ariaLabelledBy="onboarding-language-label"
                value={locale}
                onChange={(choice) => { setLocale(choice); }}
                choices={[{ value: 'en', label: 'English' }, { value: 'zh', label: '中文' }]}
              />
            </div>
          ) : null}
        </div>

        {step === 'welcome' ? (
          <div className="mt-3" data-onboarding-welcome>
            {/* What it is for, in the four uses the closing step and the hub
                are organised by. Numbered quietly, not iconified: these are a
                reading order, not four features competing for a click. */}
            <ol className="space-y-2.5" data-onboarding-intro>
              {INTRO_USES.map((use, index) => (
                <li
                  key={use.routeId}
                  data-onboarding-use={use.routeId}
                  className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-2"
                >
                  <span aria-hidden className="font-mono text-[11px] leading-5 tabular-nums text-ink-faint">
                    {index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] leading-5 font-medium text-ink">
                      {t(discoveryRoute(use.routeId).titleKey)}
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-soft">{t(use.lineKey)}</span>
                  </span>
                </li>
              ))}
            </ol>

            <div className="mt-4 border-t border-hairline pt-1">
              <button
                type="button"
                data-onboarding-appearance-toggle
                aria-expanded={appearanceOpen}
                aria-controls="onboarding-appearance-panel"
                onClick={() => { setAppearanceOpen((open) => !open); }}
                className="group -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-ink/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-ink">{t('onboarding.intro.appearance')}</span>
                  <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-soft">
                    {t('onboarding.intro.appearanceHint')}
                  </span>
                </span>
                <Icon
                  name="chevron"
                  size={12}
                  className={`shrink-0 text-ink-faint transition-transform group-hover:text-ink ${appearanceOpen ? 'rotate-90' : ''}`}
                />
              </button>
              {appearanceOpen ? (
                <div id="onboarding-appearance-panel" className="pb-1 pt-2">
                  <OnboardingAppearanceStep />
                  <p className="mt-1 text-[12px] text-ink-faint">{t('onboarding.appearance.later')}</p>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {step === 'discover' ? (
          <div className="mt-2" data-onboarding-discover>
            <p className="max-w-[52ch] text-[13px] leading-relaxed text-ink-soft">
              {t('onboarding.discover.body')}
            </p>
            {/* The five routes of the shared catalog, as the same rows the
                /discover hub shows. No accent button here on purpose — this
                page offers five peer places to start, not one recommended
                action — and every row enters the same DiscoveryContext. */}
            <div className="mt-2 space-y-1" role="group" aria-label={t('onboarding.step.discover')}>
              {DISCOVERY_ROUTES.map((route, index) => (
                <DiscoveryRouteRow
                  key={route.id}
                  route={route}
                  progress={discoveryRouteProgress(discoveryState, route.id)}
                  disabled={discoverBusy}
                  autoFocus={index === 0}
                  onSelect={() => { void startDiscoveryRoute(route.id); }}
                  data={{ 'data-onboarding-route': route.id }}
                />
              ))}
            </div>
            <FeedbackLine feedback={discoverFeedback} />
          </div>
        ) : null}

        {step === 'permissions' ? (
          <div className="mt-3 space-y-4">
            <p className="text-[13px] leading-relaxed text-ink-soft">{t('onboarding.permissions.body')}</p>
            <div role="radiogroup" aria-label={t('onboarding.step.permissions')} className="space-y-2">
              {PERMISSION_MODES.map(({ id: mode }) => (
                <PermissionOption
                  key={mode}
                  mode={mode}
                  selected={permissionMode === mode}
                  recommended={mode === RECOMMENDED_PERMISSION_MODE}
                  disabled={permissionBusy}
                  onSelect={() => {
                    permissionTouched.current = true;
                    setPermissionMode(mode);
                  }}
                />
              ))}
            </div>
            <FeedbackLine feedback={permissionFeedback} />
          </div>
        ) : null}
        </div>
        {stepScrollsMore ? (
          <div
            aria-hidden
            data-onboarding-scroll-more
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-panel to-transparent"
          />
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-hairline px-6 py-3">
        {/* The first step asks nothing, so "later" has nothing to defer and
            Next is its one action; the slot keeps its place so the footer does
            not jump between steps. */}
        {step === 'welcome' ? (
          <span aria-hidden />
        ) : (
          <button
            type="button"
            onClick={() => { void skipStep(); }}
            disabled={permissionBusy}
            className="shrink-0 text-[12px] font-medium text-ink-faint transition-colors hover:text-ink disabled:opacity-50"
          >
            {last ? t('onboarding.notNow') : t('onboarding.skip')}
          </button>
        )}
        {/* A failed hand-off belongs to the button that made it: the step is
            unchanged and only the retry is missing. */}
        <div className="flex shrink-0 items-center gap-2">
          {stepIndex > 0 ? (
            <button
              type="button"
              onClick={() => { setStep(STEPS[stepIndex - 1]!); }}
              className={SECONDARY_BUTTON}
            >
              {t('onboarding.back')}
            </button>
          ) : null}
          {/* The last step's actions are the route rows themselves, so the
              footer keeps no primary of its own. */}
          {!last ? (
            <button
              type="button"
              data-autofocus
              disabled={permissionBusy}
              onClick={() => void goNext()}
              className={PRIMARY_BUTTON}
            >
              {step === 'permissions' && permissionBusy ? t('common.saving') : t('onboarding.next')}
            </button>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

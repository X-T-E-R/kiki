/**
 * OnboardingWizard — the first-run dialog: welcome explains what Kiki can
 * help with and folds live appearance choices behind one row; the agreement
 * sets autonomy, notifications and reply style; departure hands off model
 * setup, installing kiki-ops into another agent, or a discovery route. There is
 * no workspace question: /new already defaults to the most recent workspace,
 * else a fresh folder in Kiki Home.
 *
 * Models come last on purpose. The wizard appears only for a user with no
 * usable model, and the user walks the guide first and then configures a
 * connection calmly — that is where Kiki has many paths and shows its value.
 * So the last step hands off instead of configuring: a primary button into
 * the existing Connections card, a second path that installs the `kiki-ops`
 * skill into an agent the user already has so that agent can set Kiki up,
 * and the five discovery routes folded behind a disclosure for whoever would
 * rather look around first. A route row starts that route through the same
 * DiscoveryContext the /discover hub and the sidebar entry use, so the
 * welcome invents no second flow, progress store, or resume state — and the
 * run ends only once the guarded navigation commits: a cancelled dirty-draft
 * prompt leaves both the wizard and the tour untouched, while a route that
 * genuinely cannot start (offline with no local example) says so in place
 * instead of failing silent. The hub still owns the resume banner and the
 * model connection row; nothing in this run writes a provider.
 *
 * Every primary advance button persists the current step before moving on, so
 * leaving the wizard after any Next loses nothing. The agreement's switch and
 * memory write land the moment they are chosen; only the permission default
 * waits for Next, because that is a server config patch with a failure the
 * step must be able to show. Nothing here holds an unsubmitted form, so no
 * exit path can discard one: the dialog is deliberately not dismissible, and
 * leaves on the header's close button or on an explicit action inside it.
 *
 * "Set up later" is about the current step, not the run: it steps past that
 * step to the next one and keeps walking, because that is what "later" says.
 * The first step asks nothing, so it carries only Next. On the last step,
 * where there is no next step, the same slot reads "Close setup" and closes.
 *
 * Two entries: the App shell auto-opens it when the auth/models probes report
 * a server with nothing to answer with (`shouldOfferOnboarding`), and the
 * settings About page re-opens it through `requestOnboardingOpen`. Every exit
 * path — a started route, X, or Close setup — marks the run completed
 * (`kiki.onboarding` in localStorage), so the auto-popup fires at most once.
 * The hand-off to model settings is not an exit: it closes the dialog so the
 * Connections card is reachable but leaves the run unmarked, because a model
 * connected there is what keeps the popup closed from then on, and a user who
 * comes back without one is offered the walk again. Stepping past a step is
 * not an exit either: the run stays unfinished until one of those paths is
 * taken, so a half-walked wizard can still be completed.
 */

import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { AuthSummary, PermissionMode } from '@kiki/protocol';
import type { DiscoveryRouteId } from '@kiki/session-core/discovery';
import { errorText, type Locale } from '@kiki/session-core/i18n';
import {
  isOnboardingCompleted,
  markOnboardingCompleted,
  readSettings,
  writeSettings,
} from '@kiki/session-core/settings';
import type { KikiConfigResponse } from '@kiki/session-core/transport';

import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';
import { useDiscovery } from './discovery';
import { OnboardingAgreementStep } from './OnboardingAgreementStep';
import { OnboardingAppearanceStep } from './OnboardingAppearanceStep';
import { OnboardingDepartStep } from './OnboardingDepartStep';
import { needsProviderSetup } from './NewSessionDraft';
import type { Feedback } from './controls';
import { DirtyGuardContext, useGuardedNavigate } from './dirtyGuard';
import { mergeConfigEcho } from './settings/configEcho';
import { SettingsSegmented } from './settings/SettingsPrimitives';
import { SidePanel } from './SidePanel';
import { PRIMARY_BUTTON as SHARED_PRIMARY_BUTTON } from './ui';
import { Wordmark } from './Wordmark';

// On the dark accent white text falls below AA; the on-accent ink holds it.
const PRIMARY_BUTTON = `${SHARED_PRIMARY_BUTTON} dark:text-primary-foreground`;

// Named by what each step asks, not by position, so a later `import` step can
// land after `appearance` without renumbering anything.
const STEPS = ['agreement', 'appearance', 'depart'] as const;
type OnboardingStep = (typeof STEPS)[number];

const STEP_TITLE_KEYS = {
  agreement: 'onboarding.step.agreement',
  appearance: 'onboarding.step.appearance',
  depart: 'onboarding.step.depart',
} as const;

function readInitialStep(): OnboardingStep {
  try {
    const saved = localStorage.getItem('kiki.onboarding.step');
    if (saved === 'appearance' || saved === 'depart') return saved;
    if (saved === 'welcome') return 'agreement';
  } catch {
    // Storage can be unavailable
  }
  return 'agreement';
}

/** The modes the local settings store accepts; the wire may carry the same four. */
function isStoredPermissionMode(value: unknown): value is 'manual' | 'auto' | 'review' | 'yolo' {
  return value === 'manual' || value === 'auto' || value === 'review' || value === 'yolo';
}


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

export function OnboardingWizard({ onClose }: { readonly onClose: () => void }) {
  const { client } = useConnection();
  const { t, locale, setLocale } = useI18n();
  const { startRoute } = useDiscovery();
  const dirtyGuard = useContext(DirtyGuardContext);
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<OnboardingStep>(readInitialStep);

  const goToStep = (next: OnboardingStep) => {
    try { localStorage.setItem('kiki.onboarding.step', next); } catch {}
    setStep(next);
  };

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
    node.scrollTop = 0;
    noteStepScroll();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { noteStepScroll(); });
    observer.observe(node);
    for (const child of Array.from(node.children)) observer.observe(child);
    return () => { observer.disconnect(); };
  }, [step, noteStepScroll, locale]);

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
    if (!isStoredPermissionMode(mode)) return;
    // A first run upgrades a manual server preference to the recommended auto
    // choice; reopening from Settings preserves an explicit manual preference.
    setPermissionMode(freshRun.current && mode === 'manual' ? 'auto' : mode);
  }, [configQuery.data]);

  const close = useCallback(() => {
    try { localStorage.removeItem('kiki.onboarding.step'); } catch {}
    markOnboardingCompleted();
    onClose();
  }, [onClose]);

  // Leaving the run. Scrim clicks and a bare Escape never reach here (the
  // panel is `dismissible={false}`): the header's close and the footer's
  // last-step "Set up later" are the only ways out, so neither a stray click
  // nor an interrupted thought can mark the first run done behind the user. A
  // picker opened inside the panel still owns its own Escape through the
  // shared modal-escape contract.

  /** The agreement step's save: the permission default lands in the server config. */
  const savePermissionMode = async (): Promise<boolean> => {
    // Advancing without a choice is not permission to overwrite a server value
    // that has not arrived yet. An explicit choice still saves immediately.
    if (!permissionTouched.current && configQuery.data === undefined) return true;
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
      if (isStoredPermissionMode(echoedMode)) {
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
    if (step === 'agreement') {
      if (await savePermissionMode()) {
        goToStep('appearance');
      }
      return;
    }
    if (step === 'appearance') {
      goToStep('depart');
      return;
    }
  };

  /**
   * "Set up later" leaves the *step*, not the run.
   */
  const skipStep = async () => {
    const index = STEPS.indexOf(step);
    if (index === STEPS.length - 1) {
      close();
      return;
    }
    if (step === 'agreement' && !await savePermissionMode()) return;
    goToStep(STEPS[index + 1]!);
  };

  /**
   * A route row starts that route right there: the shared DiscoveryContext
   * owns the state, the guarded navigation and the persistence, so the wizard
   * only decides what the outcome means for itself.
   */
  const startDiscoveryRoute = async (routeId: DiscoveryRouteId) => {
    setDiscoverBusy(true);
    setDiscoverFeedback(null);
    try {
      const started = await startRoute(routeId);
      if (started) {
        try { localStorage.removeItem('kiki.onboarding.step'); } catch {}
        markOnboardingCompleted();
        onClose();
      } else if (dirtyGuard?.dirty !== true) {
        setDiscoverFeedback({ tone: 'error', text: t('onboarding.discover.unavailable') });
      }
    } finally {
      setDiscoverBusy(false);
    }
  };

  /**
   * The hand-off to the Connections card goes through the same guarded
   * navigation the hub's model row uses.
   */
  const openModelSettings = () => {
    let cancelled = false;
    const result = navigate('/settings/providers?from=onboarding', undefined, () => { cancelled = true; });
    const settle = () => { if (!cancelled) onClose(); };
    if (result instanceof Promise) void result.then(settle, () => {});
    else if (dirtyGuard?.dirty !== true) settle();
  };

  const stepIndex = STEPS.indexOf(step);
  const last = stepIndex === STEPS.length - 1;

  return (
    <SidePanel
      title={step === 'agreement' ? t('onboarding.title') : t(STEP_TITLE_KEYS[step])}
      description={step === 'agreement' ? t('onboarding.intro.subtitle') : undefined}
      closeAriaLabel={t('onboarding.close')}
      overlayId="onboarding-wizard"
      width="lg"
      onClose={close}
      data={{ 'data-onboarding-dialog': '' }}
      stepKey={step}
      dismissible={false}
      back={stepIndex === 0 ? undefined : { label: t('onboarding.back'), onClick: () => { goToStep(STEPS[stepIndex - 1]!); } }}
      footer={(
        <>
          <button
            type="button"
            onClick={() => { void skipStep(); }}
            disabled={permissionBusy}
            className="shrink-0 text-[12px] font-medium text-ink-faint transition-colors hover:text-ink disabled:opacity-50"
          >
            {last ? t('onboarding.close') : t('onboarding.skip')}
          </button>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {!last ? (
              <button
                type="button"
                data-autofocus
                disabled={permissionBusy}
                onClick={() => void goNext()}
                className={PRIMARY_BUTTON}
              >
                {step === 'agreement' && permissionBusy ? t('common.saving') : t('onboarding.next')}
              </button>
            ) : null}
          </div>
        </>
      )}
    >
      {/* The step gets its own scroller inside the panel body (the panel's own
          body scroll stays unused), so a tall step says there is more below
          instead of being clipped — the same contract the dialog had. */}
      <div className="relative -mx-5 -my-4 flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          ref={stepScrollRef}
          data-onboarding-step-scroll
          onScroll={noteStepScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-5 py-4"
        >
          {/* The masthead (wordmark + step dots + language) rides the body so
              the SidePanel's fixed header stays the panel chrome. */}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2" data-onboarding-header={step === 'agreement' ? 'full' : 'compact'}>
            <span className="inline-flex" aria-hidden>
              <Wordmark size="md" />
            </span>
            <div className="flex items-center gap-3">
              {step === 'agreement' ? (
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
              <StepDots step={step} />
            </div>
          </div>

          {step === 'agreement' ? (
            <h3 className="mb-3 font-display text-[15px] leading-5 font-semibold text-ink">{t('onboarding.step.agreement')}</h3>
          ) : null}

          {step === 'agreement' ? (
            <OnboardingAgreementStep
              key={permissionMode}
              permissionMode={permissionMode}
              onPermissionModeChange={(mode) => {
                permissionTouched.current = true;
                setPermissionMode(mode);
              }}
              permissionBusy={permissionBusy}
              permissionFeedback={permissionFeedback}
            />
          ) : null}

          {step === 'appearance' ? (
            <div className="space-y-4" data-onboarding-appearance>
              <OnboardingAppearanceStep />
              <p className="mt-1 text-[12px] text-ink-faint">{t('onboarding.appearance.later')}</p>
            </div>
          ) : null}

          {step === 'depart' ? (
            <OnboardingDepartStep
              onDismiss={close}
              onOpenModelSettings={openModelSettings}
              onStartRoute={(routeId) => { void startDiscoveryRoute(routeId); }}
              discoverBusy={discoverBusy}
              discoverFeedback={discoverFeedback}
            />
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
    </SidePanel>
  );
}

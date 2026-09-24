/**
 * OnboardingWizard — the first-run setup dialog: connect a model provider,
 * pick the few preferences worth deciding up front, hear about search & fetch,
 * then land in a fresh session with `/kiki-ops …` pre-filled in the composer
 * (the user presses send; nothing auto-submits).
 *
 * Two entries: the App shell auto-opens it when the auth/models probes report
 * a server with nothing to answer with (`shouldOfferOnboarding`), and the
 * settings About page re-opens it through `requestOnboardingOpen`. Every exit
 * path — finish, skip, Esc, backdrop — marks the run completed
 * (`kiki.onboarding` in localStorage), so the auto-popup fires at most once.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { AuthSummary, PermissionMode } from '@kiki/protocol';
import { readDraft, writeDraft } from '@kiki/session-core/composer';
import { errorText, type Locale } from '@kiki/session-core/i18n';
import { sortWorkspacesByRecency } from '@kiki/session-core/sessions';
import {
  markOnboardingCompleted,
  readSettings,
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
  writeSettings,
  type ThemePreference,
} from '@kiki/session-core/settings';
import type { KikiConfigResponse } from '@kiki/session-core/transport';

import { useI18n } from '../i18n';
import { pushToast } from '../lib/toasts';
import { useConnection } from '../state/connection';
import { Dialog } from './Dialog';
import { needsProviderSetup } from './NewSessionDraft';
import { NewProviderWizard } from './ProviderFields';
import { OAuthDeviceCard } from './OAuthDeviceCard';
import { FeedbackLine, type Feedback } from './controls';
import { useGuardedNavigate } from './dirtyGuard';
import { mergeConfigEcho } from './settings/configEcho';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';
import { Wordmark } from './Wordmark';

/** The /new hero's composer draft key (see NewSessionDraft's DRAFT_KEY). */
const NEW_SESSION_DRAFT_KEY = 'new';

const STEPS = ['provider', 'preferences', 'search'] as const;
type OnboardingStep = (typeof STEPS)[number];

const STEP_TITLE_KEYS = {
  provider: 'onboarding.step.provider',
  preferences: 'onboarding.step.preferences',
  search: 'onboarding.step.search',
} as const;

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
              ? 'w-5 bg-accent'
              : dotIndex < index
                ? 'w-1.5 bg-accent/50'
                : 'w-1.5 bg-hairline-strong'
          }`}
        />
      ))}
      <span className="ml-1.5 text-[11px] tabular-nums text-ink-faint">
        {t('onboarding.progress', { current: index + 1, total: STEPS.length })}
      </span>
    </div>
  );
}

function ChoicePill({
  label,
  selected,
  disabled,
  onSelect,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
        selected
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-hairline text-ink-soft hover:border-hairline-strong'
      }`}
    >
      {label}
    </button>
  );
}

function PreferenceRow({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <span className="text-[12.5px] font-medium text-ink">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function OnboardingWizard({ onClose }: { readonly onClose: () => void }) {
  const { client } = useConnection();
  const { t, locale, setLocale } = useI18n();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<OnboardingStep>('provider');
  const [finishing, setFinishing] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthCancelling, setOauthCancelling] = useState(false);
  const [oauthFeedback, setOauthFeedback] = useState<Feedback>(null);
  const [dismissedFlows, setDismissedFlows] = useState<readonly string[]>([]);
  const prevFlowStatus = useRef<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => readSettings().defaultPermissionMode,
  );
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [permissionFeedback, setPermissionFeedback] = useState<Feedback>(null);

  const settings = useSyncExternalStore(subscribeSettings, settingsSnapshot, settingsServerSnapshot);

  const authQuery = useQuery({ queryKey: ['auth'], queryFn: () => client.getAuth(), staleTime: 10_000 });
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const oauthQuery = useQuery({
    queryKey: ['oauth'],
    queryFn: () => client.getOAuthStatus(),
    staleTime: 0,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data !== null && data !== undefined && data.status === 'pending'
        ? Math.max(2000, data.interval * 1000)
        : false;
    },
  });

  const snapshot = oauthQuery.data ?? null;

  useEffect(() => {
    const mode = configQuery.data?.default_permission_mode;
    if (mode === 'manual' || mode === 'auto' || mode === 'yolo') setPermissionMode(mode);
  }, [configQuery.data]);

  const refreshProviderData = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['providers'] }),
      queryClient.invalidateQueries({ queryKey: ['models'] }),
      queryClient.invalidateQueries({ queryKey: ['auth'] }),
      queryClient.invalidateQueries({ queryKey: ['config'] }),
    ]);
  }, [queryClient]);

  // authenticated → collapse the card and refresh the provider read-out.
  useEffect(() => {
    if (snapshot === null) {
      prevFlowStatus.current = null;
      return;
    }
    if (snapshot.status === 'authenticated' && !dismissedFlows.includes(snapshot.flow_id)) {
      if (prevFlowStatus.current === 'pending') {
        setOauthFeedback({ tone: 'success', text: t('st.oauth.authenticated') });
      }
      setDismissedFlows((flows) => [...flows, snapshot.flow_id]);
      void refreshProviderData();
    }
    prevFlowStatus.current = snapshot.status;
  }, [snapshot, dismissedFlows, t, refreshProviderData]);

  const providerReady =
    authQuery.data?.ready === true || (providersQuery.data?.items.length ?? 0) > 0;

  const close = useCallback(() => {
    markOnboardingCompleted();
    onClose();
  }, [onClose]);

  const startOAuth = async () => {
    setOauthBusy(true);
    setOauthFeedback(null);
    try {
      const result = await client.startOAuthLogin();
      if (result.status === 'authenticated') {
        setOauthFeedback({ tone: 'success', text: t('st.auth.already') });
        await refreshProviderData();
      } else {
        setDismissedFlows([]);
        queryClient.setQueryData(['oauth'], result);
      }
    } catch (error) {
      setOauthFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setOauthBusy(false);
    }
  };

  const cancelOAuth = async () => {
    setOauthCancelling(true);
    try {
      await client.cancelOAuthLogin();
    } catch (error) {
      setOauthFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setOauthCancelling(false);
      await queryClient.invalidateQueries({ queryKey: ['oauth'] });
    }
  };

  const applyPermissionMode = async (mode: PermissionMode) => {
    setPermissionMode(mode);
    setPermissionBusy(true);
    setPermissionFeedback(null);
    try {
      const echoed = await client.patchConfig({ default_permission_mode: mode });
      const merged = mergeConfigEcho(
        queryClient.getQueryData<KikiConfigResponse>(['config']) ?? configQuery.data,
        echoed,
      );
      queryClient.setQueryData(['config'], merged);
      const echoedMode = merged.default_permission_mode;
      if (echoedMode === 'manual' || echoedMode === 'auto' || echoedMode === 'yolo') {
        writeSettings({ defaultPermissionMode: echoedMode });
      }
    } catch (error) {
      setPermissionFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setPermissionBusy(false);
    }
  };

  // Finish: a fresh session with the kiki-ops setup prompt pre-filled (never
  // sent for the user). Without any workspace the server cannot anchor a
  // session, so the same prefill lands on the /new draft instead; a failed
  // create degrades there too. An existing /new draft is never overwritten.
  const finish = async () => {
    if (finishing) return;
    setFinishing(true);
    markOnboardingCompleted();
    const welcomeDraft = t('onboarding.welcomeDraft');
    const prefillNewDraft = () => {
      if (readDraft(NEW_SESSION_DRAFT_KEY) === '') {
        writeDraft(NEW_SESSION_DRAFT_KEY, welcomeDraft);
      }
    };
    try {
      const workspaces = await client
        .listWorkspaces()
        .then((result) => sortWorkspacesByRecency(result.items))
        .catch(() => []);
      const target = workspaces[0];
      if (target !== undefined) {
        const session = await client.createSession({ workspace_id: target.id });
        writeDraft(session.id, welcomeDraft);
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
        onClose();
        navigate(`/s/${session.id}`);
        return;
      }
      prefillNewDraft();
      onClose();
      navigate('/new');
    } catch {
      prefillNewDraft();
      onClose();
      pushToast({ tone: 'info', text: t('onboarding.sessionFallback') });
      navigate('/new');
    }
  };

  const goToSearchSettings = () => {
    markOnboardingCompleted();
    onClose();
    navigate('/settings/search');
  };

  const visibleSnapshot = snapshot !== null
    && snapshot.status !== 'authenticated'
    && !dismissedFlows.includes(snapshot.flow_id)
    ? snapshot
    : null;

  const stepIndex = STEPS.indexOf(step);
  const last = stepIndex === STEPS.length - 1;

  return (
    <Dialog
      onClose={close}
      ariaLabel={t('onboarding.title')}
      overlayId="onboarding-wizard"
      // Same chrome as DIALOG_PANEL_BASE, minus the padding: the wizard owns
      // its header/body/footer insets so the scroll region meets the dividers.
      panelClassName="anim-enter w-full max-w-[680px] max-h-[85vh] flex flex-col rounded-2xl border border-hairline bg-panel shadow-[0_16px_48px_-16px_rgba(28,25,23,0.35)]"
    >
      <div className="flex items-start justify-between gap-4 border-b border-hairline px-6 pb-4 pt-5">
        <div className="min-w-0">
          <span className="inline-flex" aria-hidden>
            <Wordmark size="md" />
          </span>
          <h2 className="mt-1.5 font-display text-[19px] font-semibold tracking-tight text-ink">
            {t('onboarding.title')}
          </h2>
          <p className="mt-0.5 text-[12px] text-ink-soft">{t('onboarding.subtitle')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3 pt-1">
          <StepDots step={step} />
          <button
            type="button"
            onClick={close}
            aria-label={t('onboarding.close')}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-hairline text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
          >
            <span aria-hidden>×</span>
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <h3 className="text-[13.5px] font-semibold text-ink">{t(STEP_TITLE_KEYS[step])}</h3>

        {step === 'provider' ? (
          <div className="mt-3 space-y-4">
            <p className="text-[12px] leading-relaxed text-ink-soft">{t('onboarding.provider.body')}</p>
            {providerReady ? (
              <p role="status" className="rounded-md border border-success/30 bg-success/5 px-2.5 py-2 text-[11.5px] text-success">
                {t('onboarding.provider.ready')}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={oauthBusy}
                onClick={() => void startOAuth()}
                className={SECONDARY_BUTTON}
              >
                {oauthBusy ? t('st.auth.working') : t('onboarding.provider.signIn')}
              </button>
            </div>
            {visibleSnapshot !== null ? (
              <OAuthDeviceCard
                snapshot={visibleSnapshot}
                cancelling={oauthCancelling}
                onCancel={() => void cancelOAuth()}
                onRetry={() => void startOAuth()}
                onDismiss={() => { setDismissedFlows((flows) => [...flows, visibleSnapshot.flow_id]); }}
              />
            ) : null}
            <FeedbackLine feedback={oauthFeedback} />
            <div className="border-t border-hairline pt-3">
              <p className="mb-2 text-[11px] font-medium text-ink-faint">{t('onboarding.provider.orApiKey')}</p>
              <NewProviderWizard onSaved={refreshProviderData} />
            </div>
          </div>
        ) : null}

        {step === 'preferences' ? (
          <div className="mt-3 space-y-4">
            <p className="text-[12px] leading-relaxed text-ink-soft">{t('onboarding.prefs.body')}</p>
            <PreferenceRow label={t('st.language.title')}>
              {(['en', 'zh'] as Locale[]).map((choice) => (
                <ChoicePill
                  key={choice}
                  label={choice === 'en' ? 'English' : '中文'}
                  selected={locale === choice}
                  onSelect={() => { setLocale(choice); }}
                />
              ))}
            </PreferenceRow>
            <PreferenceRow label={t('st.appearance.theme')}>
              {(['light', 'dark', 'system'] as ThemePreference[]).map((choice) => (
                <ChoicePill
                  key={choice}
                  label={t(`st.appearance.theme.${choice}`)}
                  selected={settings.theme === choice}
                  onSelect={() => { writeSettings({ theme: choice }); }}
                />
              ))}
            </PreferenceRow>
            <div className="space-y-1.5">
              <PreferenceRow label={t('st.defaults.permissionMode')}>
                {(['manual', 'auto', 'yolo'] as PermissionMode[]).map((mode) => (
                  <ChoicePill
                    key={mode}
                    label={t(`composer.mode.${mode}`)}
                    selected={permissionMode === mode}
                    disabled={permissionBusy}
                    onSelect={() => void applyPermissionMode(mode)}
                  />
                ))}
              </PreferenceRow>
              <p className={`text-[11px] leading-relaxed ${permissionMode === 'yolo' ? 'text-amber-ink' : 'text-ink-faint'}`}>
                {t(`composer.mode.${permissionMode}Hint`)}
              </p>
              <FeedbackLine feedback={permissionFeedback} />
            </div>
          </div>
        ) : null}

        {step === 'search' ? (
          <div className="mt-3 space-y-4">
            <p className="text-[12px] leading-relaxed text-ink-soft">{t('onboarding.search.body')}</p>
            <div>
              <button type="button" onClick={goToSearchSettings} className={SECONDARY_BUTTON}>
                {t('onboarding.search.configure')}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-hairline px-6 py-3.5">
        <button
          type="button"
          onClick={close}
          className="text-[11.5px] font-medium text-ink-faint transition-colors hover:text-ink"
        >
          {t('onboarding.skip')}
        </button>
        <div className="flex items-center gap-2">
          {stepIndex > 0 ? (
            <button
              type="button"
              onClick={() => { setStep(STEPS[stepIndex - 1]!); }}
              className={SECONDARY_BUTTON}
            >
              {t('onboarding.back')}
            </button>
          ) : null}
          {last ? (
            <button
              type="button"
              data-autofocus
              disabled={finishing}
              onClick={() => void finish()}
              className={PRIMARY_BUTTON}
            >
              {finishing ? t('st.auth.working') : t('onboarding.finish')}
            </button>
          ) : (
            <button
              type="button"
              data-autofocus
              onClick={() => { setStep(STEPS[stepIndex + 1]!); }}
              className={PRIMARY_BUTTON}
            >
              {t('onboarding.next')}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/**
 * OnboardingWizard — the first-run setup dialog, three steps that each say
 * one thing: welcome (language + theme), connect a model (OAuth sign-in or a
 * streamlined API-key form), and the default permission mode.
 *
 * Save semantics are explicit: every primary advance button persists the
 * current step before moving on. On the model step "Save & continue" creates
 * the provider (key + chosen model) the moment the form validates, so leaving
 * the wizard after any Next loses nothing; the "Test connection" button only
 * probes the values the form currently holds (see KikiClient.probeProviderDraft)
 * and never saves. Closing without saving (X, Esc, "Set up later") discards
 * an unsubmitted form, like any web form — everything already saved stays.
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
import { errorText, issueText, type Locale } from '@kiki/session-core/i18n';
import { sortWorkspacesByRecency } from '@kiki/session-core/sessions';
import {
  isOnboardingCompleted,
  isProviderDraftDirty,
  markOnboardingCompleted,
  PROVIDER_TEMPLATES,
  PROVIDER_WIRE_TYPES,
  providerCreateBody,
  providerTemplateFor,
  readSettings,
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
  validateNewProviderDraft,
  writeSettings,
  type ProviderDraft,
  type ProviderModelDraft,
  type ProviderTemplate,
  type ThemePreference,
} from '@kiki/session-core/settings';
import type { KikiConfigResponse } from '@kiki/session-core/transport';

import { useI18n } from '../i18n';
import { pushToast } from '../lib/toasts';
import { useConnection } from '../state/connection';
import { Dialog } from './Dialog';
import { needsProviderSetup } from './NewSessionDraft';
import { OAuthDeviceCard } from './OAuthDeviceCard';
import { FeedbackLine, Hint, type Feedback } from './controls';
import { useDirtyReporter, useGuardedNavigate } from './dirtyGuard';
import { mergeConfigEcho } from './settings/configEcho';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';
import { Wordmark } from './Wordmark';

/** The /new hero's composer draft key (see NewSessionDraft's DRAFT_KEY). */
const NEW_SESSION_DRAFT_KEY = 'new';

const STEPS = ['welcome', 'model', 'permissions'] as const;
type OnboardingStep = (typeof STEPS)[number];

const STEP_TITLE_KEYS = {
  welcome: 'onboarding.step.welcome',
  model: 'onboarding.step.model',
  permissions: 'onboarding.step.permissions',
} as const;

const PERMISSION_OPTIONS = ['auto', 'manual', 'yolo'] as const;

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
      className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-50 ${
        selected
          ? 'border-accent bg-accent-soft/40'
          : 'border-hairline bg-paper hover:border-hairline-strong'
      }`}
    >
      <span className="flex items-center gap-2">
        <span className={`text-[12.5px] font-semibold ${selected ? 'text-accent' : 'text-ink'}`}>
          {t(`composer.mode.${mode}`)}
        </span>
        {recommended ? (
          <span className="rounded-full border border-accent/40 bg-accent-soft px-1.5 py-px text-[9.5px] font-medium text-accent">
            {t('onboarding.permissions.recommended')}
          </span>
        ) : null}
      </span>
      <span className="mt-0.5 block text-[11.5px] leading-relaxed text-ink-soft">
        {t(`onboarding.permissions.${mode}.line`)}
      </span>
    </button>
  );
}

/** A fresh draft for the picked template: one blank model row, template base URL. */
function onboardingDraftFor(template: ProviderTemplate | null): ProviderDraft {
  const type = template?.type ?? 'openai';
  const blankModel: ProviderModelDraft = {
    id: '',
    remoteId: '',
    maxContextSize: providerTemplateFor(type).defaultContextSize,
    displayName: '',
    capabilities: ['thinking', 'tool_use'],
    supportEfforts: [],
    requestIdentityChoice: 'inherit',
    requestIdentityOverridesJson: '',
    imageAcceptedTypes: null,
    imageConvertUnsupported: null,
  };
  return {
    id: type,
    type,
    baseUrl: template?.baseUrl ?? '',
    defaultModel: '',
    apiKey: '',
    clearApiKey: false,
    requestIdentityChoice: 'inherit',
    requestIdentityOverridesJson: '',
    imageAcceptedTypes: null,
    imageConvertUnsupported: null,
    models: [blankModel],
  };
}

/**
 * The streamlined API-key form: template grid, then base URL + key + one
 * model. Advanced layers (request identity, image policy, extra models) stay
 * in Settings — the draft's defaults already cover them.
 */
function OnboardingProviderForm({
  draft,
  suggestions,
  probing,
  probeFeedback,
  onChange,
  onTest,
  onBack,
}: {
  readonly draft: ProviderDraft;
  readonly suggestions: readonly ProviderModelDraft[];
  readonly probing: boolean;
  readonly probeFeedback: Feedback;
  readonly onChange: (draft: ProviderDraft) => void;
  readonly onTest: () => void;
  readonly onBack: () => void;
}) {
  const { t } = useI18n();
  const [showApiKey, setShowApiKey] = useState(false);
  const model = draft.models[0];
  const isCustomTemplate = !PROVIDER_TEMPLATES.some((template) => template.type === draft.type);

  const updateModel = (patch: Partial<ProviderModelDraft>) => {
    onChange({ ...draft, models: [{ ...draft.models[0]!, ...patch }] });
  };

  const pickSuggestion = (suggestion: ProviderModelDraft) => {
    updateModel({
      remoteId: suggestion.remoteId,
      maxContextSize: suggestion.maxContextSize > 0 ? suggestion.maxContextSize : model?.maxContextSize ?? 0,
      capabilities: suggestion.capabilities.length > 0 ? [...suggestion.capabilities] : (model?.capabilities ?? []),
      supportEfforts: [...suggestion.supportEfforts],
    });
  };

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onBack}
        className="text-[11.5px] font-medium text-accent transition-colors hover:text-accent-deep"
      >
        {t('onboarding.model.changeTemplate')}
      </button>
      {isCustomTemplate ? (
        <label className="block text-[11px] font-medium text-ink-soft">
          {t('st.providers.protocol')}
          <select
            className={`${INPUT} mt-1`}
            value={draft.type}
            onChange={(event) => {
              const type = event.target.value as ProviderDraft['type'];
              onChange({ ...draft, id: type, type });
            }}
          >
            {PROVIDER_WIRE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
      ) : null}
      <label className="block text-[11px] font-medium text-ink-soft">
        {t('st.providers.baseUrl')}
        <input
          className={`${INPUT} mt-1`}
          value={draft.baseUrl}
          onChange={(event) => { onChange({ ...draft, baseUrl: event.target.value }); }}
          placeholder="https://api.example.com/v1"
        />
      </label>
      <label className="block text-[11px] font-medium text-ink-soft">
        {t('st.providers.apiKey')}
        <span className="mt-1 flex items-center gap-2">
          <input
            type={showApiKey ? 'text' : 'password'}
            autoComplete="new-password"
            className={`${INPUT} min-w-0 flex-1`}
            value={draft.apiKey}
            onChange={(event) => { onChange({ ...draft, apiKey: event.target.value }); }}
            placeholder={t('st.providers.keyNew')}
          />
          {draft.apiKey !== '' ? (
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { setShowApiKey((value) => !value); }}>
              {showApiKey ? t('st.providers.hideKey') : t('st.providers.showKey')}
            </button>
          ) : null}
        </span>
      </label>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={probing || draft.baseUrl.trim() === ''}
            onClick={onTest}
          >
            {probing ? t('st.fetchModels.working') : t('onboarding.model.test')}
          </button>
          <span className="min-w-0 flex-1 text-[10.5px] leading-relaxed text-ink-faint">
            {t('onboarding.model.testHint')}
          </span>
        </div>
        <div className="mt-2"><FeedbackLine feedback={probeFeedback} /></div>
      </div>
      <div>
        <label className="block text-[11px] font-medium text-ink-soft">
          {t('onboarding.model.model')}
          <input
            className={`${INPUT} mt-1 font-mono`}
            value={model?.remoteId ?? ''}
            onChange={(event) => {
              updateModel({
                remoteId: event.target.value,
                maxContextSize: providerTemplateFor(draft.type).defaultContextSize,
              });
            }}
            placeholder="model-id"
          />
        </label>
        {suggestions.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {suggestions.slice(0, 8).map((suggestion) => (
              <button
                key={suggestion.remoteId}
                type="button"
                data-model-suggestion={suggestion.remoteId}
                onClick={() => { pickSuggestion(suggestion); }}
                className={`rounded-full border px-2.5 py-1 font-mono text-[10.5px] transition-colors ${
                  model?.remoteId === suggestion.remoteId
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-hairline text-ink-soft hover:border-hairline-strong hover:text-ink'
                }`}
              >
                {suggestion.remoteId}
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-1"><Hint>{t('onboarding.model.modelHint')}</Hint></div>
        )}
      </div>
      <Hint>{t('onboarding.model.advancedHint')}</Hint>
    </div>
  );
}

export function OnboardingWizard({ onClose }: { readonly onClose: () => void }) {
  const { client } = useConnection();
  const { t, locale, setLocale } = useI18n();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [finishing, setFinishing] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthCancelling, setOauthCancelling] = useState(false);
  const [oauthFeedback, setOauthFeedback] = useState<Feedback>(null);
  const [dismissedFlows, setDismissedFlows] = useState<readonly string[]>([]);
  const prevFlowStatus = useRef<string | null>(null);

  // Model step: the draft lives at wizard level, so Back/Next never loses it.
  // It is only persisted by the step's own "Save & continue" (saveProvider).
  const [providerDraft, setProviderDraft] = useState<ProviderDraft | null>(null);
  const [providerBaseline, setProviderBaseline] = useState<ProviderDraft | null>(null);
  const [addingProvider, setAddingProvider] = useState(false);
  const [suggestions, setSuggestions] = useState<readonly ProviderModelDraft[]>([]);
  const [probing, setProbing] = useState(false);
  const [probeFeedback, setProbeFeedback] = useState<Feedback>(null);
  const [providerFeedback, setProviderFeedback] = useState<Feedback>(null);
  const [savingProvider, setSavingProvider] = useState(false);

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
    if (permissionTouched.current) return;
    const mode = configQuery.data?.default_permission_mode;
    if (mode !== 'manual' && mode !== 'auto' && mode !== 'yolo') return;
    // A fresh install still ships the engine's manual default; the wizard
    // preselects auto instead and persists it when the run finishes.
    setPermissionMode(freshRun.current && mode === 'manual' ? 'auto' : mode);
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

  const providerFormDirty = providerDraft !== null
    && providerBaseline !== null
    && isProviderDraftDirty(providerDraft, providerBaseline);
  useDirtyReporter('onboarding-provider', providerFormDirty && !savingProvider);

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

  const chooseTemplate = (template: ProviderTemplate | null) => {
    const draft = onboardingDraftFor(template);
    setProviderDraft(draft);
    setProviderBaseline(draft);
    setSuggestions([]);
    setProbeFeedback(null);
    setProviderFeedback(null);
  };

  const testConnection = async () => {
    if (providerDraft === null) return;
    setProbing(true);
    setProbeFeedback(null);
    setSuggestions([]);
    try {
      const models = await client.probeProviderDraft({
        type: providerDraft.type,
        baseUrl: providerDraft.baseUrl,
        apiKey: providerDraft.apiKey,
      });
      setSuggestions(models);
      setProbeFeedback({ tone: 'success', text: t('onboarding.model.testedOk', { count: models.length }) });
    } catch (error) {
      // A failed fetch surfaces as a bare TypeError ("Failed to fetch") —
      // unreachable host or a desktop CSP block; give it readable copy.
      setProbeFeedback({
        tone: 'error',
        text: error instanceof TypeError
          ? t('st.fetchModels.networkError')
          : errorText(locale, error),
      });
    } finally {
      setProbing(false);
    }
  };

  /**
   * The model step's save semantics: a pristine (never started) form advances
   * without saving; a started form validates and creates the provider —
   * key, model selection and all — before the wizard moves on. Validation or
   * write failures stay on the step with an inline error.
   */
  const saveProvider = async (): Promise<boolean> => {
    if (providerDraft === null) return true;
    const firstModel = providerDraft.models[0];
    const normalized: ProviderDraft = {
      ...providerDraft,
      defaultModel: providerDraft.defaultModel || (firstModel?.remoteId ?? ''),
    };
    const validation = validateNewProviderDraft(normalized);
    if (validation !== null) {
      setProviderFeedback({ tone: 'error', text: issueText(locale, validation) });
      return false;
    }
    setSavingProvider(true);
    setProviderFeedback(null);
    try {
      // The advance itself is the confirmation; the ready card on return
      // proves the connection persisted.
      await client.createProvider(providerCreateBody(normalized));
      await refreshProviderData();
      setProviderDraft(null);
      setProviderBaseline(null);
      setAddingProvider(false);
      setSuggestions([]);
      return true;
    } catch (error) {
      setProviderFeedback({ tone: 'error', text: errorText(locale, error) });
      return false;
    } finally {
      setSavingProvider(false);
    }
  };

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
      setStep('model');
      return;
    }
    if (step === 'model' && await saveProvider()) {
      setStep('permissions');
    }
  };

  // Finish: a fresh session with the kiki-ops setup prompt pre-filled (never
  // sent for the user). Without any workspace the server cannot anchor a
  // session, so the same prefill lands on the /new draft instead; a failed
  // create degrades there too. An existing /new draft is never overwritten.
  const finish = async () => {
    if (finishing) return;
    setFinishing(true);
    if (!await savePermissionMode()) {
      setFinishing(false);
      return;
    }
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

  const visibleSnapshot = snapshot !== null
    && snapshot.status !== 'authenticated'
    && !dismissedFlows.includes(snapshot.flow_id)
    ? snapshot
    : null;

  const stepIndex = STEPS.indexOf(step);
  const last = stepIndex === STEPS.length - 1;
  const showTemplateGrid = step === 'model'
    && providerDraft === null
    && (!providerReady || addingProvider);
  const showProviderForm = step === 'model' && providerDraft !== null;

  const modelPrimaryLabel = providerReady && !addingProvider
    ? t('onboarding.next')
    : providerDraft !== null
      ? t('onboarding.saveNext')
      : t('onboarding.next');

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

        {step === 'welcome' ? (
          <div className="mt-3 space-y-4">
            <p className="text-[12px] leading-relaxed text-ink-soft">{t('onboarding.welcome.body')}</p>
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
          </div>
        ) : null}

        {step === 'model' ? (
          <div className="mt-3 space-y-4">
            <p className="text-[12px] leading-relaxed text-ink-soft">{t('onboarding.model.body')}</p>
            {providerReady ? (
              <p role="status" className="rounded-md border border-success/30 bg-success/5 px-2.5 py-2 text-[11.5px] text-success">
                {t('onboarding.model.ready')}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={oauthBusy}
                onClick={() => void startOAuth()}
                className={SECONDARY_BUTTON}
              >
                {oauthBusy ? t('st.auth.working') : t('onboarding.model.signIn')}
              </button>
            </div>
            {visibleSnapshot !== null ? (
              <OAuthDeviceCard
                snapshot={visibleSnapshot}
                cancelling={oauthCancelling}
                onCancel={() => void cancelOAuth()}
                onRetry={() => { void startOAuth(); }}
                onDismiss={() => { setDismissedFlows((flows) => [...flows, visibleSnapshot.flow_id]); }}
              />
            ) : null}
            <FeedbackLine feedback={oauthFeedback} />
            {showTemplateGrid ? (
              <div className="border-t border-hairline pt-3">
                <p className="mb-2 text-[11px] font-medium text-ink-faint">{t('onboarding.model.orApiKey')}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {PROVIDER_TEMPLATES.map((template) => (
                    <button
                      key={template.type}
                      type="button"
                      data-provider-template={template.type}
                      onClick={() => { chooseTemplate(template); }}
                      className="rounded-xl border border-hairline bg-paper p-3 text-left transition-colors hover:border-accent hover:bg-accent-soft/40"
                    >
                      <span className="block text-[13px] font-semibold text-ink">{template.label}</span>
                      <span className="mt-0.5 block truncate font-mono text-[10.5px] text-ink-faint">{template.baseUrl}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    data-provider-template="custom"
                    onClick={() => { chooseTemplate(null); }}
                    className="rounded-xl border border-dashed border-hairline bg-paper p-3 text-left transition-colors hover:border-accent hover:bg-accent-soft/40"
                  >
                    <span className="block text-[13px] font-semibold text-ink">{t('st.wizard.manual')}</span>
                    <span className="mt-0.5 block truncate font-mono text-[10.5px] text-ink-faint">{t('st.wizard.manualHint')}</span>
                  </button>
                </div>
              </div>
            ) : null}
            {showProviderForm ? (
              <div className="border-t border-hairline pt-3">
                <p className="mb-2 text-[11px] font-medium text-ink-faint">{t('onboarding.model.orApiKey')}</p>
                <OnboardingProviderForm
                  draft={providerDraft}
                  suggestions={suggestions}
                  probing={probing}
                  probeFeedback={probeFeedback}
                  onChange={setProviderDraft}
                  onTest={() => { void testConnection(); }}
                  onBack={() => {
                    setProviderDraft(null);
                    setProviderBaseline(null);
                    setSuggestions([]);
                    setProbeFeedback(null);
                    setProviderFeedback(null);
                  }}
                />
              </div>
            ) : null}
            {providerReady && !addingProvider && providerDraft === null ? (
              <button
                type="button"
                onClick={() => { setAddingProvider(true); }}
                className="text-[11.5px] font-medium text-accent transition-colors hover:text-accent-deep"
              >
                {t('onboarding.model.addAnother')}
              </button>
            ) : null}
            <FeedbackLine feedback={providerFeedback} />
          </div>
        ) : null}

        {step === 'permissions' ? (
          <div className="mt-3 space-y-4">
            <p className="text-[12px] leading-relaxed text-ink-soft">{t('onboarding.permissions.body')}</p>
            <div role="radiogroup" aria-label={t('onboarding.step.permissions')} className="space-y-2">
              {PERMISSION_OPTIONS.map((mode) => (
                <PermissionOption
                  key={mode}
                  mode={mode}
                  selected={permissionMode === mode}
                  recommended={mode === 'auto'}
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
              disabled={finishing || permissionBusy}
              onClick={() => void finish()}
              className={PRIMARY_BUTTON}
            >
              {finishing ? t('st.auth.working') : t('onboarding.finish')}
            </button>
          ) : (
            <button
              type="button"
              data-autofocus
              disabled={savingProvider}
              onClick={() => void goNext()}
              className={PRIMARY_BUTTON}
            >
              {step === 'model'
                ? (savingProvider ? t('common.saving') : modelPrimaryLabel)
                : t('onboarding.next')}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

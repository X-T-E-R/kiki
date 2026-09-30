/**
 * OnboardingWizard — the first-run setup dialog, steps that each say one
 * thing: welcome (language, theme, palette, an optional background picture —
 * all applied live), connect a model (OAuth sign-in or a streamlined API-key
 * form), and how much it may do on its own (default permission mode). There is no workspace question: /new already defaults to
 * the most recent workspace, else a fresh folder in Kiki Home.
 *
 * Finish lands on the /new hero with an empty composer; the hero's starter
 * chips offer first prompts, nothing is prefilled or sent for the user.
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

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { AuthSummary, PermissionMode } from '@kiki/protocol';
import { errorText, issueText, type Locale } from '@kiki/session-core/i18n';
import {
  isOnboardingCompleted,
  isProviderDraftDirty,
  markOnboardingCompleted,
  providerCreateBody,
  readSettings,
  validateNewProviderDraft,
  writeSettings,
  type ProviderDraft,
  type ProviderModelDraft,
} from '@kiki/session-core/settings';
import type { KikiConfigResponse } from '@kiki/session-core/transport';

import { useI18n } from '../i18n';
import { Icon } from './icons';
import { PERMISSION_MODES, RECOMMENDED_PERMISSION_MODE } from '../lib/permissionModes';
import { useConnection } from '../state/connection';
import { ConnectionMethodPicker } from './ConnectionMethodPicker';
import { Dialog } from './Dialog';
import { OnboardingAppearanceStep, OnboardingRow } from './OnboardingAppearanceStep';
import { needsProviderSetup } from './NewSessionDraft';
import {
  API_PROTOCOLS,
  baseUrlRequired,
  connectionFieldIssue,
  draftForPreset,
  defaultContextFor,
  protocolLabel,
  withBaseUrl,
  type ConnectionField,
  type ConnectionFieldIssue,
  type ProviderPreset,
} from './providerPresets';
import { FeedbackLine, Hint, type Feedback } from './controls';
import { useDirtyReporter, useGuardedNavigate } from './dirtyGuard';
import { SearchableSelect } from './SearchableSelect';
import { mergeConfigEcho } from './settings/configEcho';
import { FieldIssue, FORM_LABEL, FORM_SELECT_TRIGGER, SettingsSegmented } from './settings/SettingsPrimitives';
import { INPUT, PRIMARY_BUTTON as SHARED_PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';
import { Wordmark } from './Wordmark';

// On the dark accent white text falls below AA; the on-accent ink holds it.
const PRIMARY_BUTTON = `${SHARED_PRIMARY_BUTTON} dark:text-primary-foreground`;

const STEPS = ['welcome', 'model', 'permissions'] as const;
type OnboardingStep = (typeof STEPS)[number];

const STEP_TITLE_KEYS = {
  welcome: 'onboarding.step.welcome',
  model: 'onboarding.step.model',
  permissions: 'onboarding.step.permissions',
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
  'flex w-full items-start gap-2.5 rounded-[10px] px-3 py-2.5 text-left transition-[background-color,box-shadow] duration-[var(--kiki-motion-quick)] focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60';
const CHOICE_CARD_SELECTED = 'bg-selected';
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
  fieldIssue,
  onChange,
  onTest,
  onBack,
}: {
  readonly draft: ProviderDraft;
  readonly suggestions: readonly ProviderModelDraft[];
  readonly probing: boolean;
  readonly probeFeedback: Feedback;
  /** The one field-level problem the last save attempt found, if any. */
  readonly fieldIssue: ConnectionFieldIssue | null;
  readonly onChange: (draft: ProviderDraft) => void;
  readonly onTest: () => void;
  readonly onBack: () => void;
}) {
  const { t, locale } = useI18n();
  const [showApiKey, setShowApiKey] = useState(false);
  const model = draft.models[0];
  const issueFor = (field: ConnectionField) =>
    fieldIssue?.field === field ? issueText(locale, fieldIssue.issue) : null;
  const idIssue = issueFor('id');
  const baseUrlIssue = issueFor('baseUrl');
  // New connections choose among the public protocols; a preset on another
  // adapter (Moonshot) keeps its own protocol listed so the value never lies.
  const protocols = API_PROTOCOLS.includes(draft.type) ? API_PROTOCOLS : [draft.type, ...API_PROTOCOLS];

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
    <div className="space-y-3" data-onboarding-provider-form>
      <button
        type="button"
        onClick={onBack}
        className="-ml-1 inline-flex h-7 items-center gap-1 rounded-md px-1 text-[12px] font-medium text-ink-soft transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
      >
        <Icon name="arrowLeft" size={12} />
        {t('onboarding.model.changeTemplate')}
      </button>
      <div>
        <label htmlFor="onboarding-provider-base-url" className={FORM_LABEL}>{t('st.providers.baseUrl')}</label>
        <input
          id="onboarding-provider-base-url"
          className={`${INPUT} mt-1 ${baseUrlIssue !== null ? 'border-danger/60' : ''}`}
          value={draft.baseUrl}
          aria-invalid={baseUrlIssue !== null || undefined}
          aria-describedby={baseUrlIssue !== null ? 'onboarding-provider-base-url-issue' : undefined}
          onChange={(event) => { onChange(withBaseUrl(draft, event.target.value)); }}
          placeholder="https://api.example.com/v1"
        />
        <FieldIssue id="onboarding-provider-base-url-issue" text={baseUrlIssue} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor="onboarding-provider-id" className={FORM_LABEL}>{t('st.providers.idLabel')}</label>
          <input
            id="onboarding-provider-id"
            className={`${INPUT} mt-1 ${idIssue !== null ? 'border-danger/60' : ''}`}
            value={draft.id}
            aria-invalid={idIssue !== null || undefined}
            aria-describedby={idIssue !== null ? 'onboarding-provider-id-issue' : undefined}
            onChange={(event) => { onChange({ ...draft, id: event.target.value }); }}
            placeholder="my-provider"
          />
          <FieldIssue id="onboarding-provider-id-issue" text={idIssue} />
        </div>
        <div className="min-w-0">
          <span id="onboarding-provider-protocol-label" className={FORM_LABEL}>{t('st.providers.protocol')}</span>
          <div className="mt-1">
            <SearchableSelect
              id="onboarding-provider-protocol"
              ariaLabel={t('st.providers.protocol')}
              value={draft.type}
              hideFilter
              options={protocols.map((type) => ({ value: type, label: protocolLabel(type), hint: type }))}
              onChange={(next) => { onChange({ ...draft, type: next as ProviderDraft['type'] }); }}
              buttonClassName={FORM_SELECT_TRIGGER}
            />
          </div>
        </div>
      </div>
      <div>
        <label htmlFor="onboarding-provider-key" className={FORM_LABEL}>{t('st.providers.apiKey')}</label>
        <span className="mt-1 flex items-center gap-2">
          <input
            id="onboarding-provider-key"
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
      </div>
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
          <span className="min-w-0 flex-1 text-[12px] leading-4 text-ink-faint">
            {t('onboarding.model.testHint')}
          </span>
        </div>
        <div className="mt-2"><FeedbackLine feedback={probeFeedback} /></div>
      </div>
      <div>
        <label htmlFor="onboarding-provider-model" className={FORM_LABEL}>{t('onboarding.model.model')}</label>
        <input
          id="onboarding-provider-model"
          className={`${INPUT} mt-1 font-mono`}
          value={model?.remoteId ?? ''}
          onChange={(event) => {
            updateModel({
              remoteId: event.target.value,
              maxContextSize: model?.maxContextSize ?? defaultContextFor(draft.type),
            });
          }}
          placeholder="model-id"
        />
        {suggestions.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label={t('onboarding.model.model')}>
            {suggestions.slice(0, 8).map((suggestion) => {
              const picked = model?.remoteId === suggestion.remoteId;
              return (
                <button
                  key={suggestion.remoteId}
                  type="button"
                  aria-pressed={picked}
                  data-model-suggestion={suggestion.remoteId}
                  onClick={() => { pickSuggestion(suggestion); }}
                  className={`h-7 rounded-md px-2.5 font-mono text-[12px] transition-colors focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none ${
                    picked
                      ? 'bg-paper font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
                      : 'text-ink-soft hover:bg-ink/[0.04] hover:text-ink'
                  }`}
                >
                  {suggestion.remoteId}
                </button>
              );
            })}
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

  // Model step: the draft lives at wizard level, so Back/Next never loses it.
  // It is only persisted by the step's own "Save & continue" (saveProvider).
  const [providerDraft, setProviderDraft] = useState<ProviderDraft | null>(null);
  const [providerBaseline, setProviderBaseline] = useState<ProviderDraft | null>(null);
  const [addingProvider, setAddingProvider] = useState(false);
  const [suggestions, setSuggestions] = useState<readonly ProviderModelDraft[]>([]);
  const [probing, setProbing] = useState(false);
  const [probeFeedback, setProbeFeedback] = useState<Feedback>(null);
  const [providerFeedback, setProviderFeedback] = useState<Feedback>(null);
  const [providerFieldIssue, setProviderFieldIssue] = useState<ConnectionFieldIssue | null>(null);
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

  const authQuery = useQuery({ queryKey: ['auth'], queryFn: () => client.getAuth(), staleTime: 10_000 });
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  useEffect(() => {
    if (permissionTouched.current) return;
    const mode = configQuery.data?.default_permission_mode;
    if (mode !== 'manual' && mode !== 'auto' && mode !== 'yolo') return;
    // A first run upgrades a manual server preference to the recommended auto
    // choice; reopening from Settings preserves an explicit manual preference.
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

  // Dialog handles Escape at the window capture phase, ahead of any popover
  // inside it. While the protocol picker is open, Escape belongs to the
  // picker: close it and keep the wizard (and the unsaved form) in place.
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

  const chooseTemplate = (template: ProviderPreset | null, protocol?: ProviderDraft['type']) => {
    const draft = draftForPreset(template, protocol);
    setProviderDraft(draft);
    setProviderBaseline(draft);
    setSuggestions([]);
    setProbeFeedback(null);
    setProviderFeedback(null);
    setProviderFieldIssue(null);
  };

  /** A form edit clears the field error it answers; other errors wait for the next save. */
  const editProviderDraft = (next: ProviderDraft) => {
    if (providerFieldIssue !== null && providerDraft !== null) {
      const field = providerFieldIssue.field;
      if ((field === 'id' && next.id !== providerDraft.id) || (field === 'baseUrl' && next.baseUrl !== providerDraft.baseUrl)) {
        setProviderFieldIssue(null);
      }
    }
    setProviderDraft(next);
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
    // Field problems (no address, no name) land on their own field; the rest
    // (models, context size) keeps the form-level line under the form.
    const fieldIssue = connectionFieldIssue(normalized, { requireBaseUrl: baseUrlRequired(normalized.type) });
    if (fieldIssue !== null) {
      setProviderFieldIssue(fieldIssue);
      setProviderFeedback(null);
      document.getElementById(fieldIssue.field === 'id' ? 'onboarding-provider-id' : 'onboarding-provider-base-url')?.focus();
      return false;
    }
    setProviderFieldIssue(null);
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

  // Finish: land on the /new hero with an empty composer. The /new draft is
  // left alone, so its own target default applies (most recent workspace,
  // else a new folder in Kiki Home). Nothing is sent or prefilled.
  const finish = async () => {
    if (finishing) return;
    setFinishing(true);
    if (!await savePermissionMode()) {
      setFinishing(false);
      return;
    }
    markOnboardingCompleted();
    onClose();
    navigate('/new');
  };

  const stepIndex = STEPS.indexOf(step);
  const last = stepIndex === STEPS.length - 1;
  const showConnectionOptions = !providerReady || addingProvider || providerDraft !== null;
  const showTemplateGrid = step === 'model' && showConnectionOptions && providerDraft === null;
  const showProviderForm = step === 'model' && providerDraft !== null;

  // Until a provider is connected the model step's advance reads as what it
  // is — skipping — and renders as a text button, not the primary action.
  const modelSkipping = !providerReady && providerDraft === null;
  const modelPrimaryLabel = providerDraft !== null
    ? t('onboarding.saveNext')
    : providerReady
      ? t('onboarding.next')
      : t('onboarding.skipForNow');

  return (
    <Dialog
      onClose={dismiss}
      ariaLabel={t('onboarding.title')}
      overlayId="onboarding-wizard"
      // Same chrome as DIALOG_PANEL_BASE, minus the padding: the wizard owns
      // its header/body/footer insets so the scroll region meets the dividers.
      panelClassName="anim-enter w-full max-w-[680px] max-h-[85vh] flex flex-col rounded-2xl border border-hairline bg-panel shadow-[0_16px_48px_-16px_rgb(var(--kiki-shadow-ink)/0.35)]"
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
            <Icon name="close" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <h3 className="font-display text-[15px] leading-5 font-semibold text-ink">{t(STEP_TITLE_KEYS[step])}</h3>

        {step === 'welcome' ? (
          <div className="mt-3" data-onboarding-welcome>
            <p className="text-[12px] leading-relaxed text-ink-soft">{t('onboarding.welcome.body')}</p>
            <div className="mt-4">
              <OnboardingRow label={t('st.language.title')} labelId="onboarding-language-label">
                <SettingsSegmented<Locale>
                  ariaLabelledBy="onboarding-language-label"
                  value={locale}
                  onChange={(choice) => { setLocale(choice); }}
                  choices={[{ value: 'en', label: 'English' }, { value: 'zh', label: '中文' }]}
                />
              </OnboardingRow>
              <div className="border-t border-hairline pt-3.5">
                <OnboardingAppearanceStep />
              </div>
            </div>
            <p className="mt-1 text-[12px] text-ink-faint">{t('onboarding.appearance.later')}</p>
          </div>
        ) : null}

        {step === 'model' ? (
          <div className="mt-3 space-y-4">
            <p className="text-[12px] leading-relaxed text-ink-soft">{t('onboarding.model.body')}</p>
            {providerReady && !showConnectionOptions ? (
              <p role="status" className="rounded-md border border-success/30 bg-success/5 px-2.5 py-2 text-[12px] text-success">
                {t('onboarding.model.ready')}
              </p>
            ) : null}
            {showTemplateGrid ? (
              <ConnectionMethodPicker dense onPickApi={chooseTemplate} onAccountChanged={refreshProviderData} />
            ) : null}
            {showProviderForm ? (
              <section aria-label={t('onboarding.model.orApiKey')} className="space-y-2" data-connection-lane="api">
                {showProviderForm ? (
                  <OnboardingProviderForm
                    draft={providerDraft}
                    suggestions={suggestions}
                    probing={probing}
                    probeFeedback={probeFeedback}
                    fieldIssue={providerFieldIssue}
                    onChange={editProviderDraft}
                    onTest={() => { void testConnection(); }}
                    onBack={() => {
                      setProviderDraft(null);
                      setProviderBaseline(null);
                      setSuggestions([]);
                      setProbeFeedback(null);
                      setProviderFeedback(null);
                      setProviderFieldIssue(null);
                    }}
                  />
                ) : null}
              </section>
            ) : null}
            {providerReady && !addingProvider && providerDraft === null ? (
              <button
                type="button"
                onClick={() => { setAddingProvider(true); }}
                className="text-[12px] font-medium text-selected-ink underline-offset-2 transition-colors hover:underline focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
              >
                {t('onboarding.model.addAnother')}
              </button>
            ) : null}
            <FeedbackLine feedback={providerFeedback} />
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

      <div className="flex items-center justify-between gap-3 border-t border-hairline px-6 py-3.5">
        <button
          type="button"
          onClick={close}
          className="text-[12px] font-medium text-ink-faint transition-colors hover:text-ink"
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
              className={step === 'model' && modelSkipping
                ? 'rounded-md px-2.5 py-1.5 text-[13px] font-medium text-ink-soft underline decoration-hairline-strong underline-offset-2 transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none'
                : PRIMARY_BUTTON}
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

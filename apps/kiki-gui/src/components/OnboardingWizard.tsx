/**
 * OnboardingWizard — the first-run setup dialog, steps that each say one
 * thing: welcome (language, theme, palette, an optional background picture —
 * all applied live), connect a model (OAuth sign-in or a streamlined API-key
 * form), and how much it may do on its own (default permission mode). There is no workspace question: /new already defaults to
 * the most recent workspace, else a fresh folder in Kiki Home.
 *
 * Finish is the one step a form cannot finish: it opens a new conversation with
 * a short `/kiki-ops` request in its composer, the same hand-off the optional
 * capability rows use, and Kiki then asks what the user is here for, offers a
 * first agent, and helps choose Explore's model and effort (or leaves it alone,
 * or turns that role off). Nothing is sent — the user reads it and presses
 * send. "Set up later" changes nothing at all and just closes the dialog;
 * whatever the user is looking at stays exactly as it was.
 *
 * Save semantics are explicit: every primary advance button persists the
 * current step before moving on. On the model step "Save & continue" creates
 * the provider (key + chosen model) the moment the form validates, so leaving
 * the wizard after any Next loses nothing; the "Test connection" button only
 * probes the values the form currently holds (see KikiClient.probeProviderDraft)
 * and never saves. Closing without saving (X, Esc, backdrop) discards
 * an unsubmitted form, like any web form — everything already saved stays.
 *
 * "Set up later" is about the current step, not the run: it steps past that
 * step to the next one and keeps walking, because that is what "later" says.
 * Only on the last step, where there is no next step, does it close. Leaving
 * the whole wizard at any point is the X, Escape or the backdrop.
 *
 * Two entries: the App shell auto-opens it when the auth/models probes report
 * a server with nothing to answer with (`shouldOfferOnboarding`), and the
 * settings About page re-opens it through `requestOnboardingOpen`. Every exit
 * path — finish, X, Esc, backdrop — marks the run completed
 * (`kiki.onboarding` in localStorage), so the auto-popup fires at most once.
 * Stepping past a step is not an exit: the run stays unfinished until one of
 * those paths is taken, so a half-walked wizard can still be completed.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { AuthSummary, PermissionMode } from '@kiki/protocol';
import { writeDraft } from '@kiki/session-core/composer';
import { errorText, issueText, type I18nKey, type Locale } from '@kiki/session-core/i18n';
import {
  isOnboardingCompleted,
  isProviderDraftDirty,
  KNOWN_CAPABILITIES,
  KNOWN_EFFORTS,
  markOnboardingCompleted,
  providerCreateBody,
  readSettings,
  REQUEST_IDENTITY_CHOICES,
  requestIdentityProfileChoice,
  validateNewProviderDraft,
  writeSettings,
  type ProviderDraft,
  type ProviderModelDraft,
  type RequestIdentityChoice,
} from '@kiki/session-core/settings';
import type { KikiConfigResponse } from '@kiki/session-core/transport';
import { formatTokens } from '@kiki/session-core/util';

import { useI18n } from '../i18n';
import { ChipSelect } from './ChipSelect';
import { Icon } from './icons';
import { PERMISSION_MODES, RECOMMENDED_PERMISSION_MODE } from '../lib/permissionModes';
import { useConnection } from '../state/connection';
import { ConnectionMethodPicker } from './ConnectionMethodPicker';
import { Dialog } from './Dialog';
import { OnboardingAppearanceStep, OnboardingRow } from './OnboardingAppearanceStep';
import { OnboardingCapabilitiesStep } from './OnboardingCapabilitiesStep';
import { needsProviderSetup } from './NewSessionDraft';
import { RequestIdentityLayerEditor } from './RequestIdentityLayerEditor';
import { useCustomIdentityChoices } from './settings/identityCatalog';
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
import { FieldIssue, FORM_LABEL, FORM_SELECT_TRIGGER, SettingsSegmented, SettingsSelect } from './settings/SettingsPrimitives';
import { INPUT, PRIMARY_BUTTON as SHARED_PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';
import { Wordmark } from './Wordmark';

// On the dark accent white text falls below AA; the on-accent ink holds it.
const PRIMARY_BUTTON = `${SHARED_PRIMARY_BUTTON} dark:text-primary-foreground`;

const STEPS = ['welcome', 'model', 'permissions', 'capabilities'] as const;
type OnboardingStep = (typeof STEPS)[number];

/**
 * The built-in client shapes, read from the same constant the settings editor
 * uses. `inherit`, the manual-overrides mode and `none` are the layer's own
 * states rather than client shapes, so they are not offered as one here:
 * inherit is the separate first row, and the other two are added by the caller
 * below, because the advanced body can leave the layer on either of them.
 */
const IDENTITY_PRESET_CHOICES = REQUEST_IDENTITY_CHOICES.filter(
  (entry): entry is Exclude<RequestIdentityChoice, 'inherit' | 'custom_overrides' | 'none'> =>
    entry !== 'inherit' && entry !== 'custom_overrides' && entry !== 'none',
);

/**
 * A compaction threshold is an absolute positive token count. The wizard reads
 * the same text in two places — the field's own blur and the save that refuses
 * on text the field never committed — so both ask this one question.
 */
function isTokenCount(text: string): boolean {
  return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) >= 1;
}

const STEP_TITLE_KEYS = {
  welcome: 'onboarding.step.welcome',
  model: 'onboarding.step.model',
  permissions: 'onboarding.step.permissions',
  capabilities: 'onboarding.step.capabilities',
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

/**
 * The request identity, as a plain choice. Which client shape the requests take
 * is a normal part of connecting a provider, so it sits in the open form next
 * to the key, not behind a disclosure.
 */
function OnboardingIdentityChoice({
  identity,
  onChange,
}: {
  identity: ProviderDraft;
  onChange: (choice: ProviderDraft['requestIdentityChoice']) => void;
}) {
  const { t } = useI18n();
  const customProfiles = useCustomIdentityChoices();
  const choice = identity.requestIdentityChoice;
  return (
    <div data-onboarding-identity>
      <div className={FORM_LABEL}>{t('onboarding.model.identity')}</div>
      <div className="mt-1">
        <SettingsSelect<ProviderDraft['requestIdentityChoice']>
          variant="form"
          dataAttr="data-request-identity-choice"
          ariaLabel={t('onboarding.model.identityAria')}
          value={choice}
          onChange={onChange}
          choices={[
            { value: 'inherit', label: t('st.requestIdentity.inheritGlobal') },
            ...IDENTITY_PRESET_CHOICES.map((preset) => ({
              value: preset as ProviderDraft['requestIdentityChoice'],
              label: t(`st.requestIdentity.option.${preset}` as I18nKey),
            })),
            ...customProfiles.map((profile) => ({
              value: requestIdentityProfileChoice(profile.id) as ProviderDraft['requestIdentityChoice'],
              label: t('st.requestIdentity.option.custom', { label: profile.label }),
            })),
            /* The advanced body can leave the layer on either of these, so they
               are offered here too rather than leaving the trigger blank for a
               state the person can actually reach. */
            { value: 'custom_overrides' as ProviderDraft['requestIdentityChoice'],
              label: t('st.requestIdentity.option.custom_overrides') },
            { value: 'none' as ProviderDraft['requestIdentityChoice'],
              label: t('st.requestIdentity.option.none') },
          ]}
        />
      </div>
      <div className="mt-1"><Hint>{t('onboarding.model.identityHint')}</Hint></div>
    </div>
  );
}

/**
 * What the first run rarely changes, kept out of the first screen so the base
 * form stays short: the hand-written override body on the request identity.
 */
function OnboardingAdvanced({
  summary,
  identity,
  onIdentity,
}: {
  summary: string;
  identity: ProviderDraft;
  onIdentity: (choice: ProviderDraft['requestIdentityChoice'], overridesJson: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const customProfiles = useCustomIdentityChoices();
  return (
    <div data-onboarding-advanced>
      <button
        type="button"
        aria-expanded={open}
        data-onboarding-advanced-toggle
        onClick={() => { setOpen((value) => !value); }}
        className="flex h-8 w-full items-center gap-1.5 rounded-md px-1 text-[12px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
      >
        <Icon name="chevron" size={12} className={open ? 'rotate-90' : undefined} />
        {summary}
      </button>
      {open ? (
        // The identity itself is chosen in the base form above, so this is the
        // part that is genuinely extra: the hand-written override body, and the
        // action that clears it back to what the identity already carries. The
        // same component the settings editor uses, asked for the body alone.
        <div className="mt-2 space-y-2" data-onboarding-advanced-body>
          <RequestIdentityLayerEditor
            value={identity}
            onChange={(next) => { onIdentity(next.requestIdentityChoice, next.requestIdentityOverridesJson); }}
            label={t('st.requestIdentity.overrides')}
            inheritLabel={t('st.requestIdentity.inheritGlobal')}
            hint={t('st.requestIdentity.overridesOptionalHint')}
            customProfiles={customProfiles}
            overridesOnly
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The streamlined API-key form: template grid, then base URL + key + one
 * model, the identity to send it as, and the model's own base traits. The
 * one rarely-needed part, the hand-written override body on that identity, sits
 * under a single Advanced disclosure rather than adding height to the first
 * screen.
 */
function OnboardingProviderForm({
  draft,
  suggestions,
  probed,
  probing,
  probeFeedback,
  fieldIssue,
  onChange,
  onTest,
  onBack,
  modelIssueRef,
}: {
  readonly draft: ProviderDraft;
  readonly suggestions: readonly ProviderModelDraft[];
  /** Whether a fetch has completed for this form (see the wizard's `probed`). */
  readonly probed: boolean;
  readonly probing: boolean;
  readonly probeFeedback: Feedback;
  /** The one field-level problem the last save attempt found, if any. */
  readonly fieldIssue: ConnectionFieldIssue | null;
  readonly onChange: (draft: ProviderDraft) => void;
  readonly onTest: () => void;
  readonly onBack: () => void;
  /**
   * A model field the form is holding as an error. The draft cannot express it
   * (an invalid value is not written to the draft), so the form reports it here
   * and the save checks it: a value the person can still see must not be saved
   * past, and must not be quietly dropped either.
   */
  readonly modelIssueRef: { current: string };
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

  /**
   * The compaction threshold is an absolute token count, and absent is a real
   * state meaning "inherit", so it cannot share the window's `0`-means-unset
   * convention. The text is held here so a wrong value stays on screen and is
   * reported, rather than being rounded into something plausible.
   *
   * The text re-reads when the stored value actually changes (a different model
   * is picked, the field is restored) and on nothing else. It is deliberately
   * not keyed to focus: tying the sync to an editing flag made blur overwrite
   * what was just typed, and drop the error the blur had only just raised.
   */
  const autoCompact = model?.autoCompact;
  const [autoCompactText, setAutoCompactText] = useState(autoCompact === undefined ? '' : String(autoCompact));
  const [autoCompactIssue, setAutoCompactIssue] = useState<string | null>(null);
  useEffect(() => {
    setAutoCompactText(autoCompact === undefined ? '' : String(autoCompact));
  }, [autoCompact]);
  /**
   * The field's own message, from either source: the blur that already ran, or
   * the live text the save refused on. Both are the same mistake in the same
   * field, so it is reported in the one place that owns the field — the save
   * that refuses only focuses it, and never adds a second copy of the sentence
   * under the form.
   */
  const pendingAutoCompact = modelIssueRef.current.trim();
  const autoCompactInvalid = pendingAutoCompact !== '' && !isTokenCount(pendingAutoCompact);
  const autoCompactMessage = autoCompactIssue
    ?? (autoCompactInvalid ? t('onboarding.model.autoCompactInvalid') : null);
  const commitAutoCompact = () => {
    const text = autoCompactText.trim();
    if (text === '') {
      setAutoCompactIssue(null);
      modelIssueRef.current = '';
      updateModel({ autoCompact: undefined });
      return;
    }
    if (!isTokenCount(text)) {
      setAutoCompactIssue(t('onboarding.model.autoCompactInvalid'));
      // Recorded here rather than read back in the event handler, so the save
      // sees this outcome and not the value the render closed over.
      modelIssueRef.current = text;
      return;
    }
    setAutoCompactIssue(null);
    modelIssueRef.current = '';
    updateModel({ autoCompact: Number(text) });
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
        <div className={FORM_LABEL}>{t('onboarding.model.model')}</div>
        {/*
          One control, not three: the searchable list filters every candidate the
          provider reported, and anything typed that is not in the list is
          offered as its own row, so a model the provider never listed, or a
          probe that never ran, is still enterable. No truncation, so no
          candidate is unreachable.

          The empty row names which of two empty states this is. Before the
          first fetch the list simply has not been read yet, so it names the
          action that reads it; after a fetch that returned nothing the
          provider's answer is the fact, and a typed id is still accepted.
        */}
        <div className="mt-1">
          <SearchableSelect
            id="onboarding-provider-model"
            data-onboarding-model-id
            ariaLabel={t('onboarding.model.model')}
            value={model?.remoteId ?? ''}
            hideFilter={false}
            allowCustomValue
            customValueLabel={(value) => t('onboarding.model.useCustomId', { id: value })}
            emptyText={t(probed ? 'onboarding.model.noModelsFetched' : 'onboarding.model.noModelsYet')}
            searchPlaceholder={t('onboarding.model.searchModels')}
            noMatchText={(value) => t('onboarding.model.useCustomId', { id: value })}
            options={suggestions.map((suggestion) => ({
              value: suggestion.remoteId,
              label: suggestion.remoteId,
              hint: suggestion.maxContextSize > 0 ? formatTokens(suggestion.maxContextSize) : undefined,
            }))}
            onChange={(remoteId) => {
              const suggestion = suggestions.find((entry) => entry.remoteId === remoteId);
              if (suggestion !== undefined) pickSuggestion(suggestion);
              else updateModel({ remoteId, maxContextSize: model?.maxContextSize ?? defaultContextFor(draft.type) });
            }}
            buttonClassName={`${FORM_SELECT_TRIGGER} font-mono`}
          />
        </div>
        {suggestions.length === 0 ? (
          <div className="mt-1"><Hint>{t(probed ? 'onboarding.model.modelHintFetched' : 'onboarding.model.modelHint')}</Hint></div>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor="onboarding-model-context" className={FORM_LABEL}>
            {t('onboarding.model.contextSize')}
            <span className="ms-1 font-normal text-ink-faint">{t('onboarding.model.tokenUnit')}</span>
          </label>
          <input
            id="onboarding-model-context"
            data-onboarding-model-context
            className={`${INPUT} mt-1 font-mono`}
            inputMode="numeric"
            value={model?.maxContextSize ? String(model.maxContextSize) : ''}
            onChange={(event) => {
              const text = event.target.value.trim();
              updateModel({ maxContextSize: /^\d+$/.test(text) ? Number(text) : 0 });
            }}
            placeholder={String(defaultContextFor(draft.type))}
          />
        </div>
        {/* The compaction threshold, in the same units as the window beside it.
            Empty means "inherit", which is what an absent value means on the
            wire: the field is only sent when one is typed. */}
        <div className="min-w-0">
          <label htmlFor="onboarding-model-auto-compact" className={FORM_LABEL}>
            {t('onboarding.model.autoCompact')}
            <span className="ms-1 font-normal text-ink-faint">{t('onboarding.model.tokenUnit')}</span>
          </label>
          <input
            id="onboarding-model-auto-compact"
            data-onboarding-model-auto-compact
            className={`${INPUT} mt-1 font-mono`}
            inputMode="numeric"
            aria-invalid={autoCompactMessage !== null || undefined}
            aria-describedby={autoCompactMessage !== null ? 'onboarding-model-auto-compact-issue' : undefined}
            value={autoCompactText}
            onChange={(event) => { setAutoCompactText(event.target.value); modelIssueRef.current = event.target.value; }}
            onBlur={() => { commitAutoCompact(); }}
            placeholder={t('onboarding.model.inheritAutoCompact')}
          />
          <FieldIssue id="onboarding-model-auto-compact-issue" text={autoCompactMessage} />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <div className={FORM_LABEL}>{t('onboarding.model.efforts')}</div>
          <div className="mt-1.5">
            <ChipSelect
              values={model?.supportEfforts ?? []}
              knownOptions={KNOWN_EFFORTS}
              onChange={(supportEfforts) => { updateModel({ supportEfforts }); }}
              ariaLabel={t('onboarding.model.efforts')}
              addPlaceholder={t('st.chips.addPlaceholder')}
              removeLabel={(value) => t('st.chips.removeAria', { value })}
            />
          </div>
        </div>
      </div>
      <div>
        <div className={FORM_LABEL}>{t('onboarding.model.capabilities')}</div>
        <div className="mt-1.5">
          <ChipSelect
            values={model?.capabilities ?? []}
            knownOptions={KNOWN_CAPABILITIES}
            onChange={(capabilities) => { updateModel({ capabilities }); }}
            ariaLabel={t('onboarding.model.capabilities')}
            addPlaceholder={t('st.chips.addPlaceholder')}
            removeLabel={(value) => t('st.chips.removeAria', { value })}
          />
        </div>
      </div>
      {/* The identity is a base choice, not an advanced layer: connecting a
          provider means saying which client shape its requests take. */}
      <OnboardingIdentityChoice
        identity={draft}
        onChange={(requestIdentityChoice) => { onChange({ ...draft, requestIdentityChoice }); }}
      />
      <OnboardingAdvanced
        summary={t('onboarding.model.advanced')}
        onIdentity={(requestIdentityChoice, requestIdentityOverridesJson) => {
          onChange({
            ...draft,
            requestIdentityChoice,
            requestIdentityOverridesJson,
          });
        }}
        identity={draft}
      />
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
  const [finishFeedback, setFinishFeedback] = useState<Feedback>(null);

  // Model step: the draft lives at wizard level, so Back/Next never loses it.
  // It is only persisted by the step's own "Save & continue" (saveProvider).
  const [providerDraft, setProviderDraft] = useState<ProviderDraft | null>(null);
  const [providerBaseline, setProviderBaseline] = useState<ProviderDraft | null>(null);
  const [addingProvider, setAddingProvider] = useState(false);
  const [suggestions, setSuggestions] = useState<readonly ProviderModelDraft[]>([]);
  // Has this form ever fetched a model list? The difference decides whether an
  // empty dropdown is "nothing to pick yet" or "the provider reported none" —
  // two different sentences, and only the second is a result.
  const [probed, setProbed] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeFeedback, setProbeFeedback] = useState<Feedback>(null);
  const [providerFeedback, setProviderFeedback] = useState<Feedback>(null);
  const [providerFieldIssue, setProviderFieldIssue] = useState<ConnectionFieldIssue | null>(null);
  const [savingProvider, setSavingProvider] = useState(false);
  /**
   * The live text of a model field the draft cannot represent: a value that did
   * not parse is never written to the draft, so the draft alone would read as
   * "inherit" and save a value the person never chose. The save reads this
   * directly, so it holds whether or not the field has been left yet. A ref
   * because it must be current inside one click, with no re-render between.
   */
  const modelIssueRef = useRef('');
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
   * changes (a step swap, a disclosure opening, a probe filling the model list)
   * or the window resizes. Measuring only on scroll would leave a tall first
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
  }, [step, noteStepScroll, providerDraft, suggestions, providerFeedback, locale]);

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
    setProbed(false);
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
      setProbed(true);
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
    // (models, context size) keeps the form-level line under the form. A model
    // field that owns its own inline message is the exception below.
    const fieldIssue = connectionFieldIssue(normalized, { requireBaseUrl: baseUrlRequired(normalized.type) });
    if (fieldIssue !== null) {
      setProviderFieldIssue(fieldIssue);
      setProviderFeedback(null);
      document.getElementById(fieldIssue.field === 'id' ? 'onboarding-provider-id' : 'onboarding-provider-base-url')?.focus();
      return false;
    }
    setProviderFieldIssue(null);
    // A model field the form is still holding as an error blocks the save. The
    // draft cannot express it, because a value that did not parse was never
    // written there, so it is read from the form itself: the person keeps the
    // text they typed, sees why the save is refused, and nothing is created.
    // The field already carries that sentence inline, and a second copy under
    // the form read as one problem said twice — and outlived the fix, because
    // this feedback is not cleared by correcting the field. So the save only
    // refuses and puts the caret back where the mistake is; it does not
    // restate it.
    const pending = modelIssueRef.current.trim();
    if (pending !== '' && !isTokenCount(pending)) {
      document.getElementById('onboarding-model-auto-compact')?.focus();
      return false;
    }
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
      setProbed(false);
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
      return;
    }
    // The permission default is saved on leaving its step, so the optional
    // capabilities page after it never holds anything unsaved.
    if (step === 'permissions' && await savePermissionMode()) {
      setStep('capabilities');
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

  // Finish: open the guided first-run conversation. The wizard has done what a
  // form can — look, a model connection, the permission default — and the rest
  // (what you use Kiki for, your first agent, Explore's model and effort) needs
  // real answers, so the same hand-off the capability rows use carries the
  // request into a new session. Nothing is sent: the user reads it and presses
  // send.
  //
  // A rejected create leaves the wizard open with the reason, and since
  // `askKiki` marks completion only after the session exists, the run is still
  // unmarked and the same button retries. That is the whole guarantee, and it
  // covers a create that fails and nothing after it: once the session is
  // written, this hand-off has the ordinary exposure — the session and its
  // draft exist, and a later failure leaves the wizard still showing.
  const finish = async () => {
    if (finishing) return;
    setFinishing(true);
    try {
      await askKiki(t('onboarding.caps.firstRun.prompt'));
    } catch (error) {
      setFinishing(false);
      setFinishFeedback({ tone: 'error', text: t('onboarding.caps.askFailed', { detail: errorText(locale, error) }) });
    }
  };

  // A capability's settings card: the wizard is done once the user leaves for it.
  const openCapability = (href: string) => {
    markOnboardingCompleted();
    onClose();
    navigate(href);
  };

  // "Let Kiki set it up": a fresh session (no workspace → a new folder in Kiki
  // Home, like /new's automatic choice) with the /kiki-ops request waiting in
  // its composer. Nothing is sent; the user reads it and presses send.
  const askKiki = async (prompt: string) => {
    const session = await client.createSession({});
    writeDraft(session.id, prompt);
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    markOnboardingCompleted();
    onClose();
    navigate(`/s/${session.id}`);
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
      // Stacked so a dialog opened from a step (the skill install preview)
      // owns Escape and focus while it is up.
      stacked
      // Same chrome as DIALOG_PANEL_BASE, minus the padding: the wizard owns
      // its header/body/footer insets so the scroll region meets the dividers.
      panelClassName="anim-enter flex h-[85vh] w-full max-w-[680px] flex-col rounded-2xl border border-hairline bg-panel shadow-[0_16px_48px_-16px_rgb(var(--kiki-shadow-ink)/0.35)]"
    >
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-hairline px-6 pb-4 pt-5">
        <div className="min-w-0">
          <span className="inline-flex" aria-hidden>
            <Wordmark size="md" />
          </span>
          <h2 className="mt-1.5 font-display text-[18px] font-semibold tracking-tight text-ink">
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

      {/* The step is taller than the dialog on a short window, so the edge says
          so while there is more below: a soft fade over the panel ground, the
          same mask the composer seat uses. No text, and it disappears the
          moment the end is reached. */}
      {/* `min-h-0` lets this flex child shrink so the step scrolls inside its
          own box and the footer below keeps its row, however long the step is. */}
      {/* A definite height, not just a cap: the scroller fills this row
          absolutely, and an absolute child needs a sized parent to fill. */}
      <div className="relative min-h-0 flex-1 shrink overflow-hidden">
        <div
          ref={stepScrollRef}
          data-onboarding-step-scroll
          onScroll={noteStepScroll}
          className="h-full min-h-0 overflow-y-auto px-6 py-4"
        >
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
              <div className="border-t border-hairline pt-3">
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
              <p role="status" className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-[12px] text-success">
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
                  modelIssueRef={modelIssueRef}
                    suggestions={suggestions}
                    probed={probed}
                    probing={probing}
                    probeFeedback={probeFeedback}
                    fieldIssue={providerFieldIssue}
                    onChange={editProviderDraft}
                    onTest={() => { void testConnection(); }}
                    onBack={() => {
                      setProviderDraft(null);
                      setProviderBaseline(null);
                      setSuggestions([]);
                      setProbed(false);
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

        {step === 'capabilities' ? (
          <OnboardingCapabilitiesStep onOpen={openCapability} onAsk={askKiki} />
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
        <button
          type="button"
          onClick={() => { void skipStep(); }}
          disabled={permissionBusy}
          className="shrink-0 text-[12px] font-medium text-ink-faint transition-colors hover:text-ink disabled:opacity-50"
        >
          {last ? t('onboarding.closeRun') : t('onboarding.skip')}
        </button>
        {/* A failed hand-off belongs to the button that made it: the step is
            unchanged and only the retry is missing. It sits inline on a wide
            footer, and wraps onto its own full-width row on a narrow one —
            squeezed between two buttons it broke "Set up later" and the error
            text mid-word. */}
        {last && finishFeedback !== null ? (
          <div className="order-last w-full min-w-0 sm:order-none sm:w-auto sm:flex-1">
            <FeedbackLine feedback={finishFeedback} />
          </div>
        ) : null}
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
          {last ? (
            <button
              type="button"
              data-autofocus
              disabled={finishing}
              onClick={() => { void finish(); }}
              className={PRIMARY_BUTTON}
            >
              {finishing ? t('st.auth.working') : t('onboarding.finishFirstRun')}
            </button>
          ) : (
            <button
              type="button"
              data-autofocus
              disabled={savingProvider || permissionBusy}
              onClick={() => void goNext()}
              className={step === 'model' && modelSkipping
                ? 'rounded-md px-3 py-1.5 text-[13px] font-medium text-ink-soft underline decoration-hairline-strong underline-offset-2 transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none'
                : PRIMARY_BUTTON}
            >
              {step === 'model'
                ? (savingProvider ? t('common.saving') : modelPrimaryLabel)
                : step === 'permissions' && permissionBusy ? t('common.saving') : t('onboarding.next')}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

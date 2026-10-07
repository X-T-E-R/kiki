import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import {
  SESSION_TITLE_TRIGGERS,
  sessionTitleModelPatch,
} from '@kiki/session-core/settings';
import type { KikiConfigResponse } from '@kiki/session-core/transport';
import { useI18n } from '../../i18n';
import { useImportHistoryEnabled } from '../../lib/importHistory';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, SavedTick, Toggle, type Feedback } from '../controls';
import { Icon } from '../icons';
import { buildCatalogModelOptions } from '../modelSelectOptions';
import { SearchableSelect, type SearchableSelectOption } from '../SearchableSelect';
import { AgentMessagingCard } from './CommunicationSection';
import { mergeConfigEcho } from './configEcho';
import { DependentField, SettingField, SettingsGroup } from './fields';
import { PlanSettings } from './PlanSettings';
import { QuestionGuardFields, rangeTextFor } from './QuestionGuardFields';
import { SectionCard } from './SectionCard';
import { SessionTitlePromptField } from './SessionTitlePromptField';
import { SettingHelp } from './SettingHelp';
import { SETTINGS_SELECT_TRIGGER, SettingsSegmented } from './SettingsPrimitives';
import {
  EMPTY_GUARD_DRAFT,
  guardDraftFromGlobalEffective,
  guardDraftProblem,
  guardDraftsEqual,
  guardEffective,
  questionGuardGlobalPatch,
  setGuardNumber,
  type QuestionGuardDraft,
} from './questionGuardDraft';
import { useInstantSave } from './useInstantSave';
import { useSavedTick } from './useSavedTick';

type QuestionBehavior = 'background' | 'blocking';

/**
 * Whether an agent's question pauses its run. Saved the moment it changes.
 *
 * The frequency guard below it is a second, separate decision about the same
 * tool: this row says what happens while a question waits, the guard says how
 * often a model is allowed to reach for one at all. They are kept apart so
 * turning the guard on never disturbs the blocking choice, and turning
 * blocking off never silently changes the thresholds.
 */
function QuestionsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const [value, setValue] = useState<QuestionBehavior>('background');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saved, ping] = useSavedTick();
  // The guard saves through the same config write as the row above, so it
  // keeps its own draft and baseline: an instant-save control must not inherit
  // the in-flight state of a control it does not own.
  const stored = configQuery.data?.interaction?.askUserQuestionGuard;
  const [guard, setGuard] = useState<QuestionGuardDraft>(EMPTY_GUARD_DRAFT);
  const [guardBase, setGuardBase] = useState<QuestionGuardDraft>(EMPTY_GUARD_DRAFT);
  const guardSave = useInstantSave();

  useEffect(() => {
    if (configQuery.data !== undefined && !saving) setValue(configQuery.data.interaction?.askUserQuestion ?? 'background');
  }, [configQuery.data, saving]);

  useEffect(() => {
    if (configQuery.data === undefined) return;
    // The draft and its baseline are re-derived from what the server holds,
    // and only when the stored guard differs from the baseline. An unsaved
    // edit has to survive this: the effect re-runs for every fresh object the
    // query cache hands back, so a draft that has not been written yet would
    // be replaced by the previous value. The baseline moves on every settled
    // read, which is what keeps the next write a diff against what is stored
    // rather than against whatever was last typed.
    const next = guardDraftFromGlobalEffective(stored);
    if (guardDraftsEqual(next, guardBase)) return;
    setGuard(next);
    setGuardBase(next);
  }, [configQuery.data, stored, guardBase]);

  const apply = async (next: QuestionBehavior) => {
    const previous = value;
    setValue(next);
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ interaction: { ask_user_question: next } });
      const merged = mergeConfigEcho(queryClient.getQueryData<KikiConfigResponse>(['config']) ?? configQuery.data, echoed);
      queryClient.setQueryData(['config'], merged);
      setValue(merged.interaction?.askUserQuestion ?? next);
      ping();
    } catch (error) {
      setValue(previous);
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  /**
   * One guard write, carrying only the field that moved. The stored value is
   * re-read from the server's echo rather than assumed, so a value the engine
   * rejected does not stay on screen as if it had been kept.
   */
  const writeGuard = (next: QuestionGuardDraft) => {
    const problem = guardDraftProblem(next, (field) => rangeTextFor(t, field));
    if (problem !== null) return;
    const patch = questionGuardGlobalPatch(next, guardBase);
    if (patch === undefined) { setGuard(next); setGuardBase(next); return; }
    void guardSave.run(async () => {
      const echoed = await client.patchConfig({ interaction: patch });
      const merged = mergeConfigEcho(queryClient.getQueryData<KikiConfigResponse>(['config']) ?? configQuery.data, echoed);
      queryClient.setQueryData(['config'], merged);
      const settled = guardDraftFromGlobalEffective(merged.interaction?.askUserQuestionGuard);
      setGuard(settled);
      setGuardBase(settled);
    });
  };

  const guardEffectiveNow = guardEffective(stored, guard);
  return (
    <SectionCard id="st-card-questions" title={t('st.sessions.questionsTitle')}>
      <div data-question-behavior className="space-y-1">
        <SettingField label={t('st.sessions.questionsLabel')} labelId="question-behavior-label" detail={t('st.sessions.questionsHint')}>
          <SettingsSegmented<QuestionBehavior>
            ariaLabelledBy="question-behavior-label"
            value={value}
            disabled={saving || configQuery.data === undefined}
            onChange={(choice) => void apply(choice)}
            choices={[
              { value: 'background', label: t('st.composer.questionsDontBlock') },
              { value: 'blocking', label: t('st.composer.questionsBlock') },
            ]}
          />
          <SavedTick show={saved} />
        </SettingField>
        <FeedbackLine feedback={feedback} />
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
      </div>
      <SettingsGroup title={t('st.questionGuard.title')}>
        <QuestionGuardFields
          scope="global"
          draft={guard}
          enabled={guardEffectiveNow.enabled}
          saving={guardSave.saving}
          saved={guardSave.saved}
          disabled={configQuery.data === undefined}
          onEnabledChange={(choice) => { writeGuard({ ...guard, enabled: choice }); }}
          onNumberCommit={(field, text) => { writeGuard(setGuardNumber(guard, field, text)); }}
        />
        <FeedbackLine feedback={guardSave.error} />
      </SettingsGroup>
    </SectionCard>
  );
}

/**
 * The three moments the engine can write a title on its own. Order is the
 * order they happen in a session's life, so the list reads as a sequence
 * rather than as three checkboxes of equal weight.
 */
const TITLE_MOMENTS = SESSION_TITLE_TRIGGERS;
type SessionTitleTrigger = (typeof TITLE_MOMENTS)[number];

/**
 * Wire id → dictionary key. The wire ids are snake_case and stable contract;
 * the keys are ours to name, so a rename on either side cannot silently
 * turn a checkbox label into a raw key.
 */
const MOMENT_LABEL_KEY: Record<SessionTitleTrigger, I18nKey> = {
  first_user_message: 'st.sessions.titleMoment.firstUserMessage',
  first_turn_completed: 'st.sessions.titleMoment.firstTurnCompleted',
  context_compacted: 'st.sessions.titleMoment.contextCompacted',
};

/**
 * What the card shows as checked. An absent list means the engine default,
 * which is the first completed reply; an empty list is a choice the user
 * made and is not the default, so the two must not collapse together.
 */
function storedTitleTriggers(stored: readonly string[] | undefined): readonly SessionTitleTrigger[] {
  if (stored === undefined) return ['first_turn_completed'];
  return TITLE_MOMENTS.filter((moment) => stored.includes(moment));
}

/**
 * Automatic session titles. The model is the choice, so it is the first row
 * and it is never hidden behind the switch: an empty model is a real state
 * that turns automatic titling off, and a user who cannot reach the picker
 * cannot turn it back on. The switch then only governs whether Kiki writes
 * titles by itself, and the moments under it say when. Below those sits the
 * instruction the title model is given, which only changes what a title reads
 * like — never whether one is written. Every control applies on change through
 * one narrow write, so changing a moment cannot drop the model and picking a
 * model cannot reset the moments. When an environment variable forces the flag
 * off, the card says so instead of pretending the switch worked.
 */
function SessionTitlesCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const metaQuery = useQuery({ queryKey: ['meta'], queryFn: () => client.meta(), staleTime: 15_000 });
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<{ enabled?: boolean; model?: string; triggers?: readonly SessionTitleTrigger[] }>({});
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saved, ping] = useSavedTick();

  const override = configQuery.data?.experimental?.['auto_session_title'];
  const effective = metaQuery.data?.experimental_flags?.['auto_session_title'];
  const enabled = pending.enabled ?? override ?? effective ?? false;
  const model = pending.model ?? configQuery.data?.session_title?.model ?? '';
  const forcedOff = enabled && effective === false && pending.enabled === undefined && override === true;
  // The engine writes a title with `session_title.model` and with nothing
  // else: no `fast_model` fallback, no managed tool
  // (agent-core-v2/session/sessionTitle/configSection.ts:24). So an empty
  // model means zero title requests, and the option has to say so.
  const configured = model.trim() !== '';
  const triggers = pending.triggers ?? storedTitleTriggers(configQuery.data?.session_title?.triggers);

  const modelOptions = useMemo<readonly SearchableSelectOption[]>(() => [
    {
      value: '',
      label: t('st.sessionTitleModel.noneDefault'),
      description: t('st.sessionTitleModel.noneDesc'),
    },
    ...buildCatalogModelOptions(modelsQuery.data?.items ?? [], t),
  ], [modelsQuery.data, t]);

  const write = async (patchFor: (latest: KikiConfigResponse) => Parameters<typeof client.patchConfig>[0], optimistic: typeof pending) => {
    setPending(optimistic);
    setSaving(true);
    setFeedback(null);
    try {
      const latest = await client.getConfig();
      const echoed = await client.patchConfig(patchFor(latest));
      queryClient.setQueryData(['config'], mergeConfigEcho(latest, echoed));
      await queryClient.invalidateQueries({ queryKey: ['meta'] });
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setPending({});
      setSaving(false);
    }
  };

  const setEnabled = (next: boolean) => write((latest) => ({
    experimental: { ...latest.experimental, auto_session_title: next },
    replace_domains: ['experimental'],
  }), { enabled: next });

  // Each write carries only the field that moved, and the route merges a
  // `session_title` patch field by field, so a write here never decides
  // anything it did not set: picking a model cannot clear the chosen moments
  // (an explicit `[]` is a choice, not an absence), changing a moment cannot
  // clear the model or the prompt, and editing the prompt cannot move either.
  // `latest` is read fresh inside the write, so the card always sends what the
  // user acted on rather than a value captured when the page was rendered.
  const setModel = (next: string) => write(() => sessionTitleModelPatch(next), { model: next });

  const setTrigger = (moment: SessionTitleTrigger, on: boolean) => {
    const next = on
      ? TITLE_MOMENTS.filter((item) => item === moment || triggers.includes(item))
      : triggers.filter((item) => item !== moment);
    // The moments travel alone. The route merges a `session_title` patch
    // field by field and keeps an absent key as it is, so writing only
    // `triggers` leaves whatever model the server holds — including one this
    // card has not read yet. Carrying the model here would write back the
    // value on screen, which goes stale the moment it is changed elsewhere,
    // and with no model chosen it would turn that change into a deletion.
    return write(() => ({ session_title: { triggers: next } }), { triggers: next });
  };

  const loading = configQuery.data === undefined;
  return (
    <SectionCard id="st-card-session-title" title={t('st.sessions.titlesTitle')}>
      <div className="space-y-1" data-session-titles>
        {loading ? (
          configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>
        ) : (
          <>
            <div data-settings-field className="py-1">
              <SettingField label={t('st.sessions.titleModel')} htmlFor="session-title-model"
                detail={configured ? t('st.sessionTitleModel.fallbackDetail') : t('st.sessionTitleModel.noneDetail')}>
                <SearchableSelect
                  id="session-title-model"
                  disabled={saving}
                  value={model}
                  options={modelOptions}
                  allowCustomValue
                  searchPlaceholder={t('st.sessionTitleModel.placeholder')}
                  ariaLabel={t('st.sessions.titleModel')}
                  emptyText={t('st.sessionTitleModel.noneDefault')}
                  buttonClassName={`${SETTINGS_SELECT_TRIGGER} w-full sm:w-64`}
                  onChange={(next) => { if (next !== model) void setModel(next); }}
                />
              </SettingField>
              {/* The one line that names the state. The switch already says
                  that Kiki writes titles by itself and the fieldset below
                  already says which moments, so repeating either one under the
                  model would restate the screen. It also does not promise that
                  picking a model is enough on its own: the switch and the
                  moments decide the rest. */}
              {!configured ? <Hint>{t('st.sessionTitleModel.unconfigured')}</Hint> : null}
            </div>
            <div data-settings-field className="space-y-0.5 py-1">
              <Toggle layout="row" label={t('st.sessions.titlesToggle')} checked={enabled} disabled={saving}
                onChange={(checked) => void setEnabled(checked)} />
              {forcedOff ? <p className="max-w-[62ch] text-[12px] leading-snug text-amber-ink" data-session-titles-forced>{t('st.sessions.titlesServerOff')}</p> : null}
            </div>
            <DependentField when={enabled}>
              <fieldset disabled={saving} className="space-y-1" data-session-title-moments>
                <legend className="mb-0.5 pt-1 text-[13px] text-ink">
                  <span className="inline-flex items-center gap-1.5">
                    {t('st.sessions.titleMoments')}
                    <SettingHelp>{t('st.sessions.titleMomentsHelp')}</SettingHelp>
                  </span>
                </legend>
                {/* The boxes show the stored choice even before a model exists:
                    preselecting is how a user stages the moments they want, and
                    the backend already sends no request without a model. The
                    one line above names that, so it is not repeated here. */}
                <div className="space-y-0.5 pt-0.5">
                  {TITLE_MOMENTS.map((moment) => (
                    <label key={moment} data-title-moment={moment}
                      className="flex min-h-7 items-center gap-2 text-[13px] text-ink">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--color-selected-ink)]"
                        checked={triggers.includes(moment)}
                        onChange={(event) => { void setTrigger(moment, event.target.checked); }}
                      />
                      {t(MOMENT_LABEL_KEY[moment])}
                    </label>
                  ))}
                </div>
              </fieldset>
            </DependentField>
            {/* Its own step under a rule: the rows above decide whether and
                when a title is written, this one decides what it says. The
                field reads the same config the rows above do, so it sits
                inside the loaded branch rather than gating itself twice. */}
            <div className="mt-2 border-t border-hairline pt-4">
              <SessionTitlePromptField disabled={saving} />
            </div>
            <SavedTick show={saved} />
          </>
        )}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

/**
 * Import an old conversation into this machine's session history.
 *
 * This is the primary place the reader meets it, because bringing history in
 * is a way of working with sessions, not a plugin to install: it ships with
 * Kiki, needs no flag, and opens the built-in import surface. It offers itself
 * only when the connected server can actually read a history — otherwise the
 * row would promise something this server cannot do.
 */
function ImportHistoryCard() {
  const { client, scopeId } = useConnection();
  const { t } = useI18n();
  const navigate = useNavigate();
  const enabled = useImportHistoryEnabled(client, scopeId).enabled === true;
  if (!enabled) return null;
  return (
    <SectionCard id="sessions-import" title={t('cap.import.entry')}>
      <p className="mt-1 max-w-[62ch] text-[13px] leading-5 text-ink-soft">
        {t('cap.import.settingsHint')}
      </p>
      <div className="mt-3">
        <button
          type="button"
          data-settings-open-import
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-hairline-strong px-3 text-[13px] font-medium text-ink transition-colors hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:h-11"
          onClick={() => { void navigate('/capabilities?view=import'); }}
        >
          <Icon name="read" size={16} className="text-ink-faint" />
          {t('cap.import.open')}
        </button>
      </div>
    </SectionCard>
  );
}

/**
 * The archive, as the first thing this section offers.
 *
 * Archived conversations are native sessions that have been set aside, and
 * clearing them is a separate operation from anything else on the page. It
 * therefore gets its own card at the top with a plain action into its own
 * page, rather than a control folded into the title or session cards: nothing
 * on this page deletes conversations, and the entry says so once, here.
 */
function ArchivedConversationsCard() {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <SectionCard id="st-card-archived" title={t('st.sessions.archivedTitle')}>
      <p className="mt-1 max-w-[62ch] text-[13px] leading-5 text-ink-soft">
        {t('st.sessions.archivedHint')}
      </p>
      <div className="mt-3">
        <button
          type="button"
          data-settings-open-archived
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-hairline-strong px-3 text-[13px] font-medium text-ink transition-colors hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:h-11"
          onClick={() => { void navigate('/archived'); }}
        >
          <Icon name="thread" size={16} className="text-ink-faint" />
          {t('st.sessions.archivedOpen')}
        </button>
      </div>
    </SectionCard>
  );
}

/**
 * Sessions: what a new session looks like and how agents behave inside one.
 * Everything here is stored on the server and instant-apply, except the
 * plan-approval timeout, which is a typed number and keeps its own Save.
 */
export function SessionsSection() {
  return (
    <>
      <ArchivedConversationsCard />
      <PlanSettings />
      <ImportHistoryCard />
      <QuestionsCard />
      <SessionTitlesCard />
      <AgentMessagingCard />
    </>
  );
}

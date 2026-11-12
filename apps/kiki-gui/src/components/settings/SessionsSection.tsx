import { useContext, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import {
  SESSION_TITLE_TRIGGERS,
  importHistoryPath,
  sessionTitleModelPatch,
} from '@kiki/session-core/settings';
import type { KikiConfigResponse } from '@kiki/session-core/transport';
import { useI18n } from '../../i18n';
import { useImportHistoryEnabled } from '../../lib/importHistory';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, SavedTick, Toggle, type Feedback } from '../controls';
import { buildCatalogModelOptions } from '../modelSelectOptions';
import { SearchableSelect, type SearchableSelectOption } from '../SearchableSelect';
import { mergeConfigEcho } from './configEcho';
import { SettingField, SettingsBox, SettingsGroup } from './fields';
import { PlanSettings } from './PlanSettings';
import { QuestionGuardFields, rangeTextFor } from './QuestionGuardFields';
import { SectionCard, SettingsCardMountContext, SettingsFlashContext } from './SectionCard';
import { SessionTitlePromptField } from './SessionTitlePromptField';
import { SettingHelp } from './SettingHelp';
import { SETTINGS_SELECT_TRIGGER, SettingsSegmented, TEXT_BUTTON } from './SettingsPrimitives';
import { BackgroundWorkCard } from './TaskRuntimeSettings';
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
    <SectionCard id="st-card-questions" title={t('st.sessions.card.questions')}>
      <div data-question-behavior>
        <SettingsBox>
          {/* The two choices say what the agent does, so they need no
              explanation beside them; the longer one stays behind the `i`. */}
          <SettingField label={t('st.sessions.ask.label')} labelId="question-behavior-label" detail={t('st.sessions.questionsHint')}>
            <SettingsSegmented<QuestionBehavior>
              ariaLabelledBy="question-behavior-label"
              value={value}
              disabled={saving || configQuery.data === undefined}
              onChange={(choice) => void apply(choice)}
              choices={[
                { value: 'background', label: t('st.sessions.ask.continue') },
                { value: 'blocking', label: t('st.sessions.ask.wait') },
              ]}
            />
            <SavedTick show={saved} />
          </SettingField>
        </SettingsBox>
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

interface TitlePending {
  enabled?: boolean;
  model?: string;
  triggers?: readonly SessionTitleTrigger[];
}

/**
 * The one write path both title cards share. Each write carries only the
 * field that moved, and the route merges a `session_title` patch field by
 * field, so a write here never decides anything it did not set: picking a
 * model cannot clear the chosen moments (an explicit `[]` is a choice, not an
 * absence), changing a moment cannot clear the model or the prompt, and
 * editing the prompt cannot move either. `latest` is read fresh inside the
 * write, so a card always sends what the user acted on rather than a value
 * captured when the page was rendered.
 */
function useSessionTitleWrite() {
  const { client } = useConnection();
  const { locale } = useI18n();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<TitlePending>({});
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saved, ping] = useSavedTick();

  const write = async (patchFor: (latest: KikiConfigResponse) => Parameters<typeof client.patchConfig>[0], optimistic: TitlePending) => {
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
  return { write, saving, pending, feedback, saved };
}

/**
 * Automatic session titles: whether Kiki names a conversation by itself, and
 * with which model. The model is a choice of its own, so it is the first row
 * and it is never hidden behind the switch: an empty model is a real state
 * that turns automatic titling off, and a user who cannot reach the picker
 * cannot turn it back on. When an environment variable forces the flag off,
 * the card says so instead of pretending the switch worked.
 *
 * When a title is written and what the title model is told are engine
 * parameters (Developer & labs › Engine parameters → `SessionTitleEngineCard`);
 * the line under the switch states the effect they add up to today.
 */
function SessionTitlesCard() {
  const { client } = useConnection();
  const { t } = useI18n();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const metaQuery = useQuery({ queryKey: ['meta'], queryFn: () => client.meta(), staleTime: 15_000 });
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const { write, saving, pending, feedback, saved } = useSessionTitleWrite();

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
  const triggers = storedTitleTriggers(configQuery.data?.session_title?.triggers);
  const modelItem = (modelsQuery.data?.items ?? []).find((item) => item.id === model);
  const modelName = modelItem?.display_name ?? model;

  const modelOptions = useMemo<readonly SearchableSelectOption[]>(() => [
    {
      value: '',
      label: t('st.sessionTitleModel.noneDefault'),
      description: t('st.sessionTitleModel.noneDesc'),
    },
    ...buildCatalogModelOptions(modelsQuery.data?.items ?? [], t),
  ], [modelsQuery.data, t]);

  const setEnabled = (next: boolean) => write((latest) => ({
    experimental: { ...latest.experimental, auto_session_title: next },
    replace_domains: ['experimental'],
  }), { enabled: next });

  const setModel = (next: string) => write(() => sessionTitleModelPatch(next), { model: next });

  // The one line that names the effect: which model writes the title after
  // the first reply. It is only said while that moment is one of the stored
  // ones, so it never describes a schedule the engine is not keeping.
  const effectLine = configured && triggers.includes('first_turn_completed')
    ? t('st.sessions.title.help', { model: modelName })
    : undefined;

  const loading = configQuery.data === undefined;
  return (
    <SectionCard id="st-card-session-title" title={t('st.sessions.card.titles')}>
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
              {/* Without a model nothing is written, whatever the switch says. */}
              {!configured ? <Hint>{t('st.sessionTitleModel.unconfigured')}</Hint> : null}
            </div>
            <div data-settings-field className="space-y-0.5 py-1">
              <SettingField label={t('st.sessions.titlesToggle')} help={effectLine}>
                <Toggle layout="bare" label={t('st.sessions.titlesToggle')} checked={enabled} disabled={saving}
                  onChange={(checked) => void setEnabled(checked)} />
              </SettingField>
              {forcedOff ? <p className="max-w-[62ch] text-[12px] leading-snug text-amber-ink" data-session-titles-forced>{t('st.sessions.titlesServerOff')}</p> : null}
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
 * Developer & labs › Engine parameters → Session titles: when the engine
 * writes a title on its own, and the instruction the title model is given.
 * Both used to sit on Sessions; a person sees titles, not the schedule or the
 * prompt behind them, so they moved here (settings conventions §3.5) with
 * their saves unchanged: each moment writes on its own, the prompt keeps its
 * own Save. The moments stay visible while automatic titling is off or no
 * model is chosen: preselecting is how a user stages them, and the engine
 * sends no request without a model anyway.
 */
export function SessionTitleEngineCard() {
  const { client } = useConnection();
  const { t } = useI18n();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const { write, saving, pending, feedback, saved } = useSessionTitleWrite();
  const triggers = pending.triggers ?? storedTitleTriggers(configQuery.data?.session_title?.triggers);

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

  return (
    <SectionCard id="st-card-session-title-engine" title={t('st.sessions.titlesTitle')}>
      <div className="space-y-1" data-session-title-engine>
        {configQuery.data === undefined ? (
          configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>
        ) : (
          <>
            <fieldset disabled={saving} className="space-y-1" data-session-title-moments>
              <legend className="mb-0.5 pt-1 text-[13px] text-ink">
                <span className="inline-flex items-center gap-1.5">
                  {t('st.sessions.titleMoments')}
                  <SettingHelp>{t('st.sessions.titleMomentsHelp')}</SettingHelp>
                </span>
              </legend>
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
            <SavedTick show={saved} />
            <FeedbackLine feedback={feedback} />
            {/* Its own step: the moments decide when a title is written, this
                decides what it says. It keeps its own Save. */}
            <div className="mt-4">
              <SessionTitlePromptField disabled={saving} />
            </div>
          </>
        )}
      </div>
    </SectionCard>
  );
}

const IMPORT_CARD = 'st-card-import-history';

/** The card's two ways into history are quiet ink verbs, not buttons in boxes. */
const ENTRY_LINK = `h-8 shrink-0 pointer-coarse:h-10 ${TEXT_BUTTON}`;

/**
 * The import row. It offers itself only when the connected server can read a
 * history, so it never promises something this server cannot do. It keeps
 * its own card anchor: search hits and old links name it, and it announces
 * itself the way a card does, so the page can scroll to it and flash it.
 */
function ImportHistoryRow() {
  const { client, scopeId } = useConnection();
  const { t } = useI18n();
  const navigate = useNavigate();
  const flashId = useContext(SettingsFlashContext);
  const onCardMount = useContext(SettingsCardMountContext);
  const enabled = useImportHistoryEnabled(client, scopeId).enabled === true;
  useEffect(() => { if (enabled) onCardMount?.(IMPORT_CARD); }, [enabled, onCardMount]);
  if (!enabled) return null;
  return (
    <div id="st-card-import-history" data-settings-card={IMPORT_CARD}
      className={`scroll-mt-4 ${flashId === IMPORT_CARD ? 'settings-card-flash' : ''}`}>
      <SettingField label={t('st.sessions.importRow')} help={t('st.sessions.importRowHint')}>
        <button type="button" data-settings-open-import className={ENTRY_LINK}
          onClick={() => { void navigate(importHistoryPath()); }}>
          {t('cap.import.open')}
        </button>
      </SettingField>
    </div>
  );
}

/**
 * How many archived conversations there are, when the server can say so. The
 * list API has no total, so one page is read: a page that is not followed by
 * another is the whole archive and its length is the count; a longer archive
 * is "some", and the row says only "Archived conversations". The key sits
 * under the archive page's own prefix, so that page's deletes refresh it.
 */
const ARCHIVE_COUNT_PAGE = 100;

function useArchivedCount(): { known: boolean; count: number } {
  const { client, scopeId } = useConnection();
  const query = useQuery({
    queryKey: ['archived-sessions', scopeId, { count: ARCHIVE_COUNT_PAGE }],
    queryFn: () => client.listSessions({ archived_only: true, page_size: ARCHIVE_COUNT_PAGE }),
    staleTime: 15_000,
    retry: false,
  });
  if (query.data === undefined || query.data.has_more) return { known: false, count: 0 };
  return { known: true, count: query.data.items.length };
}

/**
 * Conversations kept outside the sidebar, and conversations brought in from
 * elsewhere: two ways into history, one card. The archive row says how many
 * there are when the server can tell, and offers the archive only when there
 * is something in it; nothing here deletes or imports by itself.
 */
function ConversationHistoryCard() {
  const { t, tp } = useI18n();
  const navigate = useNavigate();
  const archived = useArchivedCount();
  const empty = archived.known && archived.count === 0;
  const label = !archived.known ? t('st.sessions.archivedRow')
    : empty ? t('st.sessions.archive.none')
    : tp('st.sessions.archive.count', archived.count);
  return (
    <SectionCard id="st-card-archived" title={t('st.sessions.historyTitle')}>
      <SettingsBox>
        <div data-settings-archive-row={archived.known ? String(archived.count) : 'unknown'}>
          <SettingField label={label} help={empty ? undefined : t('st.sessions.archivedRowHint')}>
            {empty ? null : (
              <button type="button" data-settings-open-archived className={ENTRY_LINK}
                onClick={() => { void navigate('/archived'); }}>
                {t('st.sessions.archive.view')}
              </button>
            )}
          </SettingField>
        </div>
        <ImportHistoryRow />
      </SettingsBox>
    </SectionCard>
  );
}

/**
 * Sessions: one page that answers how new conversations start, how they get
 * named, and what happens to background work — five cards in the order a
 * person meets them. Engine internals that used to share these pages (title
 * moments and prompt, task caps, residency, resource ceilings) live under
 * Developer & labs › Engine parameters, and the plan-mode approval gate is a
 * permission. Old `?tab=` addresses still open this page; the card hash in
 * them still lands on its card.
 */
export function SessionsSection() {
  return (
    <div className="space-y-6" data-sessions-page>
      <PlanSettings />
      <SessionTitlesCard />
      <QuestionsCard />
      <BackgroundWorkCard />
      <ConversationHistoryCard />
    </div>
  );
}

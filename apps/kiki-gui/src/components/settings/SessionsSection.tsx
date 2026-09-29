import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import { sessionTitleModelPatch } from '@kiki/session-core/settings';
import type { KikiConfigResponse } from '@kiki/session-core/transport';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, SavedTick, Toggle, type Feedback } from '../controls';
import { buildCatalogModelOptions } from '../modelSelectOptions';
import { SearchableSelect, type SearchableSelectOption } from '../SearchableSelect';
import { AgentMessagingCard } from './CommunicationSection';
import { mergeConfigEcho } from './configEcho';
import { DependentField, SettingField } from './fields';
import { PlanSettings } from './PlanSettings';
import { SectionCard } from './SectionCard';
import { SETTINGS_SELECT_TRIGGER, SettingsSegmented } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

type QuestionBehavior = 'background' | 'blocking';

/** Whether an agent's question pauses its run. Saved the moment it changes. */
function QuestionsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const [value, setValue] = useState<QuestionBehavior>('background');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saved, ping] = useSavedTick();

  useEffect(() => {
    if (configQuery.data !== undefined && !saving) setValue(configQuery.data.interaction?.askUserQuestion ?? 'background');
  }, [configQuery.data, saving]);

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

  return (
    <SectionCard id="st-card-questions" title={t('st.sessions.questionsTitle')}>
      <div data-question-behavior className="space-y-1">
        <SettingField label={t('st.sessions.questionsLabel')} labelId="question-behavior-label" help={t('st.sessions.questionsHint')}>
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
    </SectionCard>
  );
}

/**
 * Automatic session titles. The feature flag and its model used to be two
 * controls behind one Save button inside an "experimental" card; here they
 * are one switch and one dependent picker, each applied on change. The
 * switch writes the config override; when an environment variable forces the
 * flag off, the card says so instead of pretending the switch worked.
 */
function SessionTitlesCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const metaQuery = useQuery({ queryKey: ['meta'], queryFn: () => client.meta(), staleTime: 15_000 });
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<{ enabled?: boolean; model?: string }>({});
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saved, ping] = useSavedTick();

  const override = configQuery.data?.experimental?.['auto_session_title'];
  const effective = metaQuery.data?.experimental_flags?.['auto_session_title'];
  const enabled = pending.enabled ?? override ?? effective ?? false;
  const model = pending.model ?? configQuery.data?.session_title?.model ?? '';
  const forcedOff = enabled && effective === false && pending.enabled === undefined && override === true;

  const modelOptions = useMemo<readonly SearchableSelectOption[]>(() => [
    { value: '', label: t('st.sessionTitleModel.managedDefault'), description: t('st.sessionTitleModel.managedDesc') },
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
    experimental: { ...(latest.experimental ?? {}), auto_session_title: next },
    replace_domains: ['experimental'],
  }), { enabled: next });

  const setModel = (next: string) => write(() => sessionTitleModelPatch(next), { model: next });

  const loading = configQuery.data === undefined;
  return (
    <SectionCard id="st-card-session-title" title={t('st.sessions.titlesTitle')}>
      <div className="space-y-1" data-session-titles>
        {loading ? (
          configQuery.isError ? <InlineError error={configQuery.error} /> : <Hint>{t('st.runtime.loading')}</Hint>
        ) : (
          <>
            <div data-settings-field className="space-y-0.5 py-1">
              <Toggle layout="row" label={t('st.sessions.titlesToggle')} checked={enabled} disabled={saving}
                onChange={(checked) => void setEnabled(checked)} />
              <Hint>{t('st.sessions.titlesHint')}</Hint>
              {forcedOff ? <p className="max-w-[62ch] text-[12px] leading-snug text-amber-ink" data-session-titles-forced>{t('st.sessions.titlesServerOff')}</p> : null}
            </div>
            <DependentField when={enabled}>
              <SettingField label={t('st.sessions.titleModel')} htmlFor="session-title-model" help={t('st.sessions.titleModelHint')}>
                <SearchableSelect
                  id="session-title-model"
                  disabled={saving}
                  value={model}
                  options={modelOptions}
                  allowCustomValue
                  searchPlaceholder={t('st.sessionTitleModel.placeholder')}
                  ariaLabel={t('st.sessions.titleModel')}
                  emptyText={t('st.sessionTitleModel.managedDefault')}
                  buttonClassName={`${SETTINGS_SELECT_TRIGGER} w-64`}
                  onChange={(next) => { if (next !== model) void setModel(next); }}
                />
              </SettingField>
            </DependentField>
            <SavedTick show={saved} />
          </>
        )}
        <FeedbackLine feedback={feedback} />
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
      <PlanSettings />
      <QuestionsCard />
      <SessionTitlesCard />
      <AgentMessagingCard />
    </>
  );
}
